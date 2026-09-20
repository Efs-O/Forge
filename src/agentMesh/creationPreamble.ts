import type { ForgeConfig } from '../config/types';
import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import type { ClaudeOwnedSession } from '../agents/ClaudeOwnedSession';
import { relayToClaude } from '../agentBus/claudeRelay';
import { sendPeerMessage, type ClaudeSession } from '../agentBus/claudePeer';
import { getAlias, type AliasRecord } from './aliasRegistry';
import type { HostLivenessDeps } from './hostIdentity';
import { getHostIdentity } from './hostIdentity';
import { claimCreation, readOwnership, waitForRecord, type OwnershipRecord } from './ownership';

/**
 * The shared first-creation preamble (F-01/F-04) plus the default owned-session
 * factories, extracted from sessionProvider.ts (which is at the 500-line lint
 * limit). The preamble owns the two things every first-creation path must do
 * before spawning:
 *
 * 1. **Claim the lease** (O_EXCL). If another window holds it, wait (bounded)
 *    for its ownership record and signal a re-resolve (the caller re-enters
 *    `ensureOwned*`, which now finds the record) instead of reporting an error
 *    while the peer's session is about to be ready. A torn claim (no holder) or
 *    a timeout is a refusal.
 * 2. **Gate first-creation consent** (F-01). When there is no prior alias or
 *    session id, a first creation is a user-visible, one-time consented
 *    privileged spawn. When the wiring supplies no consent gate, the creation
 *    is REFUSED — a silent privileged spawn is the F-01 defect this prevents.
 */

export type CreationStart =
  | { kind: 'refuse'; error: string }
  | { kind: 'join' }
  | {
      kind: 'proceed';
      host: ReturnType<typeof getHostIdentity>;
      rec: OwnershipRecord | undefined;
      aliasRec: AliasRecord | undefined;
    };

export async function beginCreation(
  busRoot: string,
  alias: string,
  isForeignLiveOwner: (owner: { pid: number; startedAt: number }) => boolean,
  reResolve: () => Promise<unknown>,
  deps: HostLivenessDeps,
): Promise<CreationStart> {
  const host = getHostIdentity(deps);
  const claim = claimCreation(busRoot, alias, host, deps);
  if (!claim.claimed) {
    // F-04: a live holder is creating. Wait (bounded) for its ownership record
    // and re-resolve (join it), instead of reporting an error while the peer's
    // session is about to be ready. A torn claim (no holder) or a timeout is
    // still a refusal — we never race a possibly-live creator.
    if (claim.holder) {
      const rec = await waitForRecord(busRoot, alias, 5_000);
      if (rec && rec.owner_host && !isForeignLiveOwner(rec.owner_host)) {
        await reResolve();
        return { kind: 'join' };
      }
    }
    return {
      kind: 'refuse',
      error: `creation for "${alias}" is already in progress (another window holds the lease)`,
    };
  }
  const rec = readOwnership(busRoot, alias);
  const aliasRec = getAlias(busRoot, alias);
  return { kind: 'proceed', host, rec, aliasRec };
}

/**
 * F-01: gate a first creation on consent. Returns a refusal reason when consent
 * is required but either no gate is wired or the user declined; `undefined`
 * when the creation may proceed (not a first creation, or consent was given).
 */
export async function gateFirstCreationConsent(
  alias: string,
  isFirstCreation: boolean,
  requestConsent: ((alias: string) => Promise<boolean>) | undefined,
): Promise<string | undefined> {
  if (!isFirstCreation) return undefined;
  if (!requestConsent) {
    return `creating a Forge-owned ${alias} session requires consent, but no consent gate is wired; nothing was started`;
  }
  const consent = await requestConsent(alias);
  if (!consent) {
    return `creating a Forge-owned ${alias} session was not consented; nothing was started`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Default owned-session factories + the default Claude transport (moved out of
// sessionProvider.ts to keep it under the 500-line lint limit).
// ---------------------------------------------------------------------------

export interface OwnedCodexFactory {
  create(options: {
    alias: string;
    threadId: string | undefined;
    executable: string;
    cwd: string;
    model?: string;
  }): Promise<CodexAppServerSession>;
}

export interface OwnedClaudeFactory {
  create(options: {
    alias: string;
    sessionId: string | undefined;
    executable: string;
    cwd: string;
    model?: string;
  }): Promise<ClaudeOwnedSession>;
}

export function defaultSendClaude(
  bus: ForgeConfig['agent_bus'],
): (session: ClaudeSession, message: string, signal?: AbortSignal) => Promise<void> {
  return (session, message, signal) => {
    if (bus?.claude_transport === 'relay') {
      return relayToClaude(bus.claude_cli, bus.relay_model, session.name, message, signal);
    }
    return sendPeerMessage(session, 'Forge', message);
  };
}

export function defaultCodexFactory(): OwnedCodexFactory {
  return {
    create: async ({ executable, cwd, model, threadId }) => {
      const { CodexAppServerSession } = await import('../agents/CodexAppServerSession');
      return new CodexAppServerSession({
        executable,
        cwd,
        ...(model ? { model } : {}),
        ...(threadId ? { confirmedSessionId: threadId } : {}),
      });
    },
  };
}

export function defaultClaudeFactory(): OwnedClaudeFactory {
  return {
    create: async ({ executable, cwd, model, sessionId }) => {
      const { ClaudeOwnedSession } = await import('../agents/ClaudeOwnedSession');
      return new ClaudeOwnedSession({
        executable,
        cwd,
        ...(model ? { model } : {}),
        ...(sessionId ? { confirmedSessionId: sessionId } : {}),
      });
    },
  };
}
