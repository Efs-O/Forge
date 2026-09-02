import type { HostActivityEvent } from '../sidebar/HostActivity';
import type { RemoteController } from './RemoteController';

/**
 * Which fan-out a host activity event belongs to.
 *
 * Sits beside remoteCompactionNotice for the same reason: it is a policy
 * decision about what a remote user should be told, not part of the transport
 * lifecycle RemoteRuntime owns. All three branches deliver the same text; they
 * differ only in who hears it and what can silence it.
 *
 * - No conversation → window scope. A model unloaded affects every chat bound
 *   to this workspace, including ones on a different conversation.
 * - `kind: 'turn'` → the echo of a finished answer, the only kind that can
 *   duplicate what a chat already saw. mirrorTurn declines when a progress
 *   message already owns that turn, and it is what /mirror off silences.
 * - Anything else → the conversation's chats, riding /notify with compaction
 *   and notify_user.
 *
 * Returns the number of chats reached, matching the fan-outs it delegates to.
 */
export function routeHostActivity(
  event: HostActivityEvent,
  controller: RemoteController,
): Promise<number> {
  if (event.conversationId === undefined) {
    return controller.broadcastHostNotification(event.text);
  }
  return event.kind === 'turn'
    ? controller.mirrorTurn(event.conversationId, event.text)
    : controller.enqueueHostNotification(event.conversationId, event.text);
}
