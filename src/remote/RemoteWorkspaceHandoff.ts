/**
 * Moving one chat from the window that serves it to another project's window.
 *
 * A handoff spans two processes: this window records it durably and closes,
 * the target window claims it on startup, binds a fresh conversation, and
 * tells the chat it arrived. Keeping the three steps together is the point —
 * the arrival receipt only makes sense next to the departure that caused it.
 */

import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import * as path from 'path';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { WorkspaceHandoff } from './RemoteStoreSchemas';
import type { WorkspaceAliasTarget } from './RemoteWorkspaceDiscovery';
import type { RemoteChannel } from './types';

/** Exactly how extension.ts derives a workspace id, so the target window
 *  recognises the record as its own. */
export function workspaceIdFor(target: string): string {
  const resolved = path.resolve(target);
  if (process.platform !== 'win32') {
    return createHash('sha256').update(resolved).digest('hex');
  }

  // Windows paths are case-insensitive. Ask the filesystem for its canonical
  // spelling so aliases with different casing converge, then retain VS Code's
  // lowercase-drive convention to preserve existing workspace ids.
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // A configured target may disappear between discovery and hashing. Keep
    // the deterministic resolved spelling so its setup error is surfaced by
    // the caller rather than hidden here.
  }
  canonical = canonical.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Records the departure and returns its id. The caller stops its transports
 *  and opens the target folder; this only makes the move durable first, and
 *  the id is what lets the caller undo it if no window ever claims. */
export async function recordWorkspaceHandoff(
  store: RemoteRequestStore,
  sourceWorkspaceId: string,
  target: WorkspaceAliasTarget,
  alias: string,
  channel: string,
  chatId: string,
): Promise<string> {
  return store.beginWorkspaceHandoff({
    channel: channel as WorkspaceHandoff['channel'],
    chatId,
    sourceWorkspaceId,
    targetWorkspaceId: workspaceIdFor(target.path),
    targetAlias: alias,
  });
}

/** Claims any handoff addressed to this window and binds the chat to a new
 *  conversation here. Returns what it claimed so the caller can announce it. */
export async function resumeWorkspaceHandoffs(
  store: RemoteRequestStore,
  workspaceId: string,
  host: ForgeHostFacade,
): Promise<WorkspaceHandoff[]> {
  const handoffs = await store.claimWorkspaceHandoffs(workspaceId);
  for (const handoff of handoffs) {
    const conversation = await host.createConversation({ activate: false });
    await store.setBinding({
      channel: handoff.channel,
      chatId: handoff.chatId,
      workspaceId,
      conversationId: conversation.id,
    });
    await store.completeWorkspaceHandoff(handoff.id);
  }
  return handoffs;
}

export interface ArrivalAnnouncement {
  channelFor: (name: WorkspaceHandoff['channel']) => RemoteChannel | undefined;
  displayNameFor: (alias: string) => string;
  /** Enrolled TOTP means the arriving chat is locked: sessions are memory-only
   *  and live in the window that authenticated them, so they never cross into
   *  the window taking over — whether or not a reload was involved. */
  totpEnrolled: (channel: WorkspaceHandoff['channel']) => Promise<boolean>;
  notifyLocal: (message: string) => void;
}

/**
 * The arrival receipt, sent from the window that actually came up.
 *
 * Without it the switch looked hung: the last thing the chat heard was
 * "switching…", the window reloaded, and the authentication challenge only
 * appears if the user happens to send something into a session they have no
 * reason to think is locked.
 */
export async function announceWorkspaceArrivals(
  arrivals: readonly WorkspaceHandoff[],
  deps: ArrivalAnnouncement,
): Promise<void> {
  for (const handoff of arrivals) {
    const channel = deps.channelFor(handoff.channel);
    if (!channel) continue;
    const name = deps.displayNameFor(handoff.targetAlias);
    const locked = await deps.totpEnrolled(handoff.channel).catch(() => true);
    try {
      await channel.send(
        handoff.chatId,
        locked
          ? `Forge: now in ${name} — a new chat is bound here. Your session did not carry over, so this chat is locked: send your 6-digit code to unlock it.`
          : `Forge: now in ${name} — a new chat is bound here.`,
      );
    } catch (err) {
      // The switch itself succeeded; a failed receipt is worth surfacing
      // locally but must not tear down a transport that just came up.
      deps.notifyLocal(
        `Forge remote: could not confirm the workspace switch in ${handoff.channel} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
