import type { RemoteChannel } from './types';
import type { RemoteCommandContext } from './RemoteCommandHandler';

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
 * Why a destructive model command must wait: an active request chain, a live
 * stream, a pending approval, or queued remote work would be orphaned by an
 * unload or restart. Returns `undefined` when the window is idle.
 */
export function globalBusyReason(context: RemoteCommandContext): string | undefined {
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
