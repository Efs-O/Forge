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
import { getLogger } from '../util/logger';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { WorkspaceHandoff } from './RemoteStoreSchemas';
import { handoffMode } from './RemoteHandoffState';
import type { WorkspaceAliasTarget } from './RemoteWorkspaceDiscovery';
import type { RemoteChannel } from './types';

const log = getLogger();

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
 *  the id is what lets the caller undo it if no window ever claims. `mode` is
 *  written so the window that arrives can tell the chat which window it is in
 *  and whether the old one is still open. */
export async function recordWorkspaceHandoff(
  store: RemoteRequestStore,
  sourceWorkspaceId: string,
  target: WorkspaceAliasTarget,
  alias: string,
  channel: string,
  chatId: string,
  mode: 'replace' | 'new-window',
): Promise<string> {
  return store.beginWorkspaceHandoff({
    channel: channel as WorkspaceHandoff['channel'],
    chatId,
    sourceWorkspaceId,
    targetWorkspaceId: workspaceIdFor(target.path),
    targetAlias: alias,
    mode,
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
  /** Set when the chat was opened here but the binding write failed, so the
   *  record still names the workspace that sent it and every message from the
   *  chat is refused until `/workspace` runs again. */
  bindingFailure?: string;
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
  // Read, do not claim: the conversation this chat is going to continue has to
  // be opened **before** anything durable lands, because the old order — claim,
  // then await the open, then write the binding — left a `claimed` record
  // behind whenever the window reloaded or crashed in that gap, and only
  // `pending` records are claimable, so nothing could take the chat back while
  // the source window had already stopped serving it.
  const handoffs = store.peekWorkspaceHandoffs(workspaceId);
  // `peek`, not claim: see the comment below and `claimBindAndComplete` in
  // `RemoteHandoffState.ts`. The authoritative claimability check happens
  // again inside the single write that claims, binds and completes.
  const arrivals: WorkspaceArrival[] = [];
  for (const handoff of handoffs) {
    const resumed = await resumeNewestConversation(host);
    let conversation: Awaited<ReturnType<ForgeHostFacade['createConversation']>>;
    try {
      conversation = resumed ?? (await host.createConversation({ activate: false }));
    } catch (err) {
      // Nothing has landed yet, so this is still a claim: made and completed in
      // one write, without a binding, so the source window does not undo a
      // switch whose target window is up and serving. A window that beat us to
      // the record says nothing at all.
      const taken = await store.claimAndBindWorkspaceHandoff(handoff.id, workspaceId);
      if (!taken.ok) {
        log.debug(`[remote] handoff ${handoff.id} was taken by another window`);
        continue;
      }
      const failure = err instanceof Error ? err.message : String(err);
      arrivals.push({
        handoff: taken.handoff,
        conversationTitle: '',
        created: false,
        failure,
      });
      continue;
    }
    // Claim, bind and complete in one write. A throw means the write did not
    // happen at all — the record is still pending, this window holds the lease,
    // and the source's rollback will find it cannot take that lease back — so
    // report it rather than pretending the chat moved.
    let taken: { ok: true; handoff: WorkspaceHandoff } | { ok: false };
    try {
      taken = await store.claimAndBindWorkspaceHandoff(handoff.id, workspaceId, {
        channel: handoff.channel,
        chatId: handoff.chatId,
        workspaceId,
        conversationId: conversation.id,
      });
    } catch (err) {
      arrivals.push({
        handoff,
        conversationTitle: conversation.title,
        created: resumed === undefined,
        bindingFailure: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!taken.ok) {
      log.debug(`[remote] handoff ${handoff.id} was taken by another window`);
      continue;
    }
    arrivals.push({
      handoff: taken.handoff,
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
  /** Names the workspace a record came from, so a `new-window` receipt can say
   *  which window is still open. Optional because a window whose config lists
   *  no aliases cannot name it — the receipt then says "the window you came
   *  from" rather than inventing a name. */
  displayNameForWorkspaceId?: (workspaceId: string) => string | undefined;
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
    // A `new-window` arrival is a second window, so the receipt has to say what
    // happened to the first one: without this the owner cannot tell whether
    // their old window is still serving other chats, and `replace` receipts
    // stay exactly as they were (that mode writes no `mode` field of its own
    // beyond today's, and an absent `mode` means `replace`).
    const opening =
      handoffMode(handoff) === 'new-window'
        ? `opened as a new window, and ${
            deps.displayNameForWorkspaceId?.(handoff.sourceWorkspaceId) ??
            'the window you came from'
          } is still open — `
        : '';
    const locked = await deps.totpEnrolled(handoff.channel).catch(() => true);
    // Naming the conversation is the difference between "it worked" and
    // "did it put me somewhere useful?": the receipt used to say "a new chat
    // is bound here" whatever it bound, so there was no way to tell a resumed
    // conversation from a blank one without running /view.
    if (arrival.bindingFailure) {
      // The chat is open here but still bound to where it came from, so the
      // next message would be refused: name the command that finishes the move.
      await sendReceipt(
        channel,
        handoff,
        `Forge: now in ${name}, but this chat could not be bound here (${arrival.bindingFailure.replace(/^Forge: /, '')}). It is still bound where it was — send /workspace ${handoff.targetAlias} again.`,
        deps,
      );
      continue;
    }
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
        ? `Forge: now in ${name} — ${opening}${where}. Your session did not carry over, so this chat is locked: send your 6-digit code to unlock it.`
        : `Forge: now in ${name} — ${opening}${where}.`,
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
