import type { RemoteChannel } from './types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestStore } from './RemoteRequestStore';

/**
 * Helpers shared by more than one remote-command module. Kept in their own file
 * so the command-family modules never import each other (no new value cycles).
 */

/** Best-effort edit of a progress message; silently skipped when unsupported. */
export async function editProgress(
  channel: RemoteChannel,
  chatId: string,
  messageId: string | undefined,
  text: string,
): Promise<void> {
  if (!messageId || !channel.editMessage) return;
  await channel.editMessage(chatId, messageId, text).catch(() => undefined);
}

/**
 * Why a destructive command must wait: an active request chain, a live stream,
 * a pending approval, or queued remote work would be orphaned by an unload, a
 * restart or a window reload. Returns `undefined` when the window is idle.
 *
 * Takes the two fields it reads rather than the whole command context, so the
 * workspace switch — which has a narrower context slice — can ask the same
 * question without pretending to have fields it does not have.
 */
export function globalBusyReason(context: {
  host: ForgeHostFacade;
  store: RemoteRequestStore;
}): string | undefined {
  const status = context.host.status();
  if (
    status.requestChains.length ||
    status.streamingConversationIds.length ||
    status.pendingApproval
  ) {
    return 'Forge is busy; wait for requests, streams, and approvals to finish';
  }
  return context.store.queued().length > 0 ? 'Forge has queued remote requests' : undefined;
}

/**
 * What a switch that stops this window's transports would actually cut: a
 * conversation **this workspace is bound to** that is streaming, sitting in a
 * request chain, or holding the pending approval, plus the queued prompts this
 * window is holding. Narrower than {@link globalBusyReason} on purpose —
 * `RemoteController.stop()` cancels the conversations bound to the transports it
 * stops and nothing else, so a turn typed into another window's chat is not this
 * switch's business, and refusing `new-window` for it would make the owner give
 * up a move that costs them nothing. `replace` still uses the global check: a
 * window reload does kill everything in the window.
 *
 * It is **not** filtered to the channel the command came from: `stopActive()`
 * stops every transport this window runs, so a WhatsApp turn is cut by a switch
 * asked from Telegram, and an unfiltered check is the only way to warn about it.
 */
export function transportsBusyReason(context: {
  host: ForgeHostFacade;
  store: RemoteRequestStore;
  workspaceId: string;
}): string | undefined {
  const bound = new Set(
    context.store
      .bindingsForWorkspace(context.workspaceId)
      .map((binding) => binding.conversationId),
  );
  const status = context.host.status();
  const stopped =
    status.streamingConversationIds.some((id) => bound.has(id)) ||
    status.requestChains.some((chain) => bound.has(chain.conversationId)) ||
    // An approval with no conversation is not attributable, so it counts: a
    // switch that drops it leaves a tool waiting for an answer nobody can give.
    (status.pendingApproval !== undefined &&
      (!status.pendingApproval.conversationId || bound.has(status.pendingApproval.conversationId)));
  if (stopped) return 'Forge remote has conversations answering on these transports';
  return context.store.queued().length > 0
    ? 'Forge remote has queued prompts waiting on these transports'
    : undefined;
}
