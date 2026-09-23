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

/** One claimed handoff and the conversation this window put the chat into. */
export interface WorkspaceArrival {
  handoff: WorkspaceHandoff;
  /** Title of the bound conversation, so the receipt can name where you are. */
  conversationTitle: string;
  /** True when nothing was here to continue and a chat had to be created. */
  created: boolean;
  /** Set when no chat could be opened (every open chat busy at the cap). The
   *  handoff still completes: this window serves the chat now, just unbound. */
  failure?: string;
}

/**
 * Claims any handoff addressed to this window and binds the chat here.
 *
 * Binds the workspace's most recently updated conversation, NOT a new one.
 * `/workspace 27` is "go to 27 and carry on"; landing in an empty chat meant
 * every switch cost a `/chats` and a `/chat 1` to undo, and the work you
 * switched in order to continue was one command further away than before you
 * left. A workspace with no history at all is the only case that still gets a
 * fresh chat, because there is nothing else it could mean.
 */
export async function resumeWorkspaceHandoffs(
  store: RemoteRequestStore,
  workspaceId: string,
  host: ForgeHostFacade,
): Promise<WorkspaceArrival[]> {
  const handoffs = await store.claimWorkspaceHandoffs(workspaceId);
  const arrivals: WorkspaceArrival[] = [];
  for (const handoff of handoffs) {
    const resumed = await resumeNewestConversation(host);
    let conversation: Awaited<ReturnType<ForgeHostFacade['createConversation']>>;
    try {
      conversation = resumed ?? (await host.createConversation({ activate: false }));
    } catch (err) {
      // One claimed handoff that cannot open a chat must not strand the rest
      // of the batch, or abort the transport start it runs ahead of.
      await store.completeWorkspaceHandoff(handoff.id);
      const failure = err instanceof Error ? err.message : String(err);
      arrivals.push({ handoff, conversationTitle: '', created: false, failure });
      continue;
    }
    await store.setBinding({
      channel: handoff.channel,
      chatId: handoff.chatId,
      workspaceId,
      conversationId: conversation.id,
    });
    await store.completeWorkspaceHandoff(handoff.id);
    arrivals.push({
      handoff,
      conversationTitle: conversation.title,
      created: resumed === undefined,
    });
  }
  return arrivals;
}

/**
 * The newest conversation this workspace has, reopened if it was archived.
 *
 * Returns undefined rather than throwing: `restoreConversation` throws on the
 * MAX_CONVERSATIONS cap, and a full tab bar must not turn an arrival into a
 * chat bound to nothing — a new conversation is a worse landing than the one
 * you wanted, but it is a landing.
 */
async function resumeNewestConversation(host: ForgeHostFacade) {
  const newest = host
    .status()
    .conversations.slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!newest) return undefined;
  return host.restoreConversation(newest.id, { activate: false }).catch(() => undefined);
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
  arrivals: readonly WorkspaceArrival[],
  deps: ArrivalAnnouncement,
): Promise<void> {
  for (const arrival of arrivals) {
    const { handoff } = arrival;
    const channel = deps.channelFor(handoff.channel);
    if (!channel) continue;
    const name = deps.displayNameFor(handoff.targetAlias);
    const locked = await deps.totpEnrolled(handoff.channel).catch(() => true);
    // Naming the conversation is the difference between "it worked" and
    // "did it put me somewhere useful?": the receipt used to say "a new chat
    // is bound here" whatever it bound, so there was no way to tell a resumed
    // conversation from a blank one without running /view.
    if (arrival.failure) {
      await sendReceipt(
        channel,
        handoff,
        `Forge: now in ${name}, but no chat could be opened: ${arrival.failure.replace(/^Forge: /, '')} Finish or close a chat here, then /chats to pick one.`,
        deps,
      );
      continue;
    }
    const where = arrival.created
      ? 'nothing was here to continue, so a new chat is bound'
      : `continuing “${clipTitle(arrival.conversationTitle)}” — /chats to pick another`;
    await sendReceipt(
      channel,
      handoff,
      locked
        ? `Forge: now in ${name} — ${where}. Your session did not carry over, so this chat is locked: send your 6-digit code to unlock it.`
        : `Forge: now in ${name} — ${where}.`,
      deps,
    );
  }
}

async function sendReceipt(
  channel: RemoteChannel,
  handoff: WorkspaceHandoff,
  text: string,
  deps: ArrivalAnnouncement,
): Promise<void> {
  try {
    await channel.send(handoff.chatId, text);
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

/** Conversation titles are user text; keep a receipt to one readable line. */
function clipTitle(title: string): string {
  const characters = [...title];
  return characters.length <= 60 ? title : `${characters.slice(0, 59).join('')}…`;
}
