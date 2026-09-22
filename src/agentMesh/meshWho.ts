import * as fs from 'fs';
import { listAliases } from './aliasRegistry';
import { listOwnedAliases, ownershipPath, readOwnership } from './ownership';
import { isHostAlive, type HostLivenessDeps } from './hostIdentity';
import type { ClaudeSession } from '../agentBus/claudePeer';

/**
 * The `forge.sh who` projection (AGENT_MESH_PLAN §11). A read-only list of every
 * mesh participant (forge, claude, codex, and any other registered alias) with
 * its state. It composes the raw sources directly — the alias table, the
 * ownership records, and the in-memory FIFO — rather than `projectLiveSessions`
 * (a presentation projection that cannot see `busy` or the joined/owned split).
 *
 * Two axes, not one enum: `attachment` (how this host reaches the participant)
 * and `activity` (what the participant is doing). A session can be owned AND
 * parked, or owned AND busy, so a single `state` word would be lossy.
 *
 * The honesty rule: only a participant this host OWNS (holds the stdio pipe
 * and can watch its FIFO) may report `busy` or `idle`. A joined session, a
 * pinned thread, or a session another live window owns is `unknown` — never
 * `idle`. Guessing `idle` is the dangerous lie: a sender then expects a fast
 * answer and escalates. Likewise a session another live window owns is
 * `attachment: peer` (we can write to it, not watch it), not `owned` — the
 * word `owned` is reserved for the host holding the pipe.
 *
 * Pure: no writes, no posting. The wiring layer supplies the in-memory signals
 * (the owning window's FIFO, the sidebar's streaming state, the inbox depth);
 * this module only reads the durable records and applies the rules.
 */

export type Attachment = 'hub' | 'joined' | 'owned' | 'peer' | 'none';
export type Activity = 'busy' | 'idle' | 'parked' | 'unknown' | 'dead' | 'none';

export interface WhoParticipant {
  alias: string;
  attachment: Attachment;
  activity: Activity;
  detail?: string;
}

export interface WhoDeps {
  busRoot: string;
  /** The known aliases (registered + the live config pins). */
  knownAliases: () => string[];
  /** True when THIS host holds the stdio pipe for the alias (may watch its FIFO). */
  isOwner: (alias: string) => boolean;
  /** True when THIS host's FIFO for the alias is running a turn (in-memory). */
  isBusy: (alias: string) => boolean;
  /** Forge's own activity: true while the active conversation is streaming. */
  forgeBusy: () => boolean;
  /** Forge's queued bus-message depth (the "does my message wait?" number). */
  forgeInboxDepth: () => number;
  /** Host liveness (injectable for tests; production reads the OS). */
  hostLiveness?: HostLivenessDeps;
  /** Live Claude sessions, to resolve a joined alias after a reload changed its
   *  pid. Omitted: the joined row shows the pid recorded at join time. */
  claudeSessions?: () => ClaudeSession[];
}

/** The full participant set: forge + every registered, owned, or known alias. */
function participantAliases(deps: WhoDeps): string[] {
  const aliases = listAliases(deps.busRoot);
  const owned = listOwnedAliases(deps.busRoot);
  const set = new Set<string>(['forge']);
  for (const alias of Object.keys(aliases)) set.add(alias);
  for (const alias of owned) set.add(alias);
  for (const alias of deps.knownAliases()) set.add(alias);
  return [...set].sort();
}

/**
 * Project the `who` table. Forge is always first (it is the hub), then the rest
 * in sorted order.
 */
export function projectWho(deps: WhoDeps): WhoParticipant[] {
  const liveness = deps.hostLiveness ?? {};
  // Honor an injected `isHostAlive` override (the same pattern ownership.ts uses):
  // the `isHostAlive` function itself only reads `isAlive`/`processStartMs`, so
  // without this an override on `hostLiveness` would be silently ignored.
  const alive =
    liveness.isHostAlive ?? ((h: { pid: number; startedAt: number }) => isHostAlive(h, liveness));
  const rest = participantAliases(deps)
    .filter((alias) => alias !== 'forge')
    .map((alias): WhoParticipant => {
      try {
        return projectOne(alias, deps, alive);
      } catch {
        // A liveness probe that throws (or any unexpected read error) must never
        // take the whole route down: one bad participant is `unknown`, not a 500.
        return { alias, attachment: 'none', activity: 'unknown', detail: 'state unreadable' };
      }
    });
  return [forgeParticipant(deps), ...rest];
}

/** Forge's own line: it is the hub, busy exactly while its active chat streams. */
function forgeParticipant(deps: WhoDeps): WhoParticipant {
  const busy = deps.forgeBusy();
  const depth = deps.forgeInboxDepth();
  return {
    alias: 'forge',
    attachment: 'hub',
    activity: busy ? 'busy' : 'idle',
    ...(depth > 0 ? { detail: `inbox ${depth}` } : {}),
  };
}

function projectOne(
  alias: string,
  deps: WhoDeps,
  alive: (recorded: { pid: number; startedAt: number }) => boolean,
): WhoParticipant {
  const aliasRec = listAliases(deps.busRoot)[alias];
  const rec = readOwnership(deps.busRoot, alias);

  // Attachment: how THIS host reaches the participant.
  // A joined (user-opened) session — the alias record carries peer_pid — is
  // reached through its pipe and never owned, so it wins over any record.
  if (aliasRec?.peer_pid !== undefined) {
    // Non-observing: we can write to it but not watch it. Never busy, never
    // idle — only unknown (the honesty rule).
    if (!deps.claudeSessions) {
      return {
        alias,
        attachment: 'joined',
        activity: 'unknown',
        detail: `pid ${aliasRec.peer_pid}`,
      };
    }
    // A reload restarts the session under a new pid with the same sessionId —
    // the same match routing uses (pickClaudePeer), so `who` agrees with it.
    const sessions = deps.claudeSessions();
    const live =
      sessions.find((s) => s.pid === aliasRec.peer_pid) ??
      (aliasRec.claude_session_id
        ? sessions.find((s) => s.sessionId === aliasRec.claude_session_id)
        : undefined);
    if (!live) {
      return {
        alias,
        attachment: 'joined',
        activity: 'dead',
        detail: 'not running — open its panel',
      };
    }
    return { alias, attachment: 'joined', activity: 'unknown', detail: `pid ${live.pid}` };
  }

  if (rec) {
    // An ownership record exists. `readOwnership` normalizes a present-but-
    // malformed `owner_host` to null, so re-read the raw field to tell a clean
    // close (genuine null → dead, resumable) from corruption (→ unknown, not
    // proven dead).
    if (rec.owner_host === null) {
      if (!rawOwnerHostIsNull(deps.busRoot, alias)) {
        return {
          alias,
          attachment: 'owned',
          activity: 'unknown',
          detail: 'owner record malformed',
        };
      }
      return {
        alias,
        attachment: 'owned',
        activity: 'dead',
        ...(rec.thread_id ? { detail: 'thread kept for resume' } : {}),
      };
    }
    // owner_host is present and well-formed.
    if (!alive(rec.owner_host)) {
      // Owner host proven dead: reapable, thread kept for resume.
      return {
        alias,
        attachment: 'owned',
        activity: 'dead',
        ...(rec.thread_id ? { detail: 'thread kept for resume' } : {}),
      };
    }
    // The owner host is live.
    if (deps.isOwner(alias)) {
      // This host holds the pipe: it can watch its FIFO, so busy/idle/parked is
      // honest. `parked` is read from the durable record, so it is observable
      // even without turn observation.
      if (rec.parked) {
        return {
          alias,
          attachment: 'owned',
          activity: 'parked',
          detail: 'warm (thread resumable)',
        };
      }
      const busy = deps.isBusy(alias);
      return {
        alias,
        attachment: 'owned',
        activity: busy ? 'busy' : 'idle',
        ...(busy ? { detail: 'turn in flight' } : {}),
      };
    }
    // A session another LIVE window owns: this host does not hold its pipe, so
    // it cannot see whether a turn is running. `peer` (we can write, not
    // watch), activity unknown — never idle.
    return { alias, attachment: 'peer', activity: 'unknown', detail: 'owned by another live host' };
  }

  if (aliasRec || deps.knownAliases().includes(alias)) {
    // A pinned thread or registered alias with no ownership record: reached as
    // a peer, not observable from this host.
    return {
      alias,
      attachment: 'peer',
      activity: 'unknown',
      detail: 'not observable from this host',
    };
  }

  return { alias, attachment: 'none', activity: 'none' };
}

/**
 * True when the ownership record's `owner_host` is genuinely `null` (a clean
 * close). `readOwnership` normalizes a present-but-malformed `owner_host` to
 * null too, so this re-reads the raw field to keep the two apart: only a
 * genuine null is `dead`; a malformed one is `unknown` (unprovable death is not
 * proven death).
 */
function rawOwnerHostIsNull(root: string, alias: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(ownershipPath(root, alias), 'utf8');
  } catch {
    return false; // absent: readOwnership would have returned undefined, not a null-owner record
  }
  let rec: { owner_host?: unknown };
  try {
    rec = JSON.parse(raw) as { owner_host?: unknown };
  } catch {
    return false; // corrupt JSON: not a proven clean close
  }
  return 'owner_host' in rec && rec.owner_host === null;
}
