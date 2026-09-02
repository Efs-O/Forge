import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { CompactionEvent } from '../sidebar/CompactionService';
import type { HostActivityEvent } from '../sidebar/HostActivity';
import type { RemoteController } from './RemoteController';
import { routeHostActivity } from './remoteActivityRouting';

export interface HostSubscriptions {
  dispose(): void;
}

export interface HostSubscriptionHandlers {
  /** Compaction is trigger-filtered by policy, so the runtime keeps that call. */
  onCompaction: (event: CompactionEvent) => void;
  onActivityError: (message: string) => void;
}

/**
 * Bind one controller to every outbound hook the host offers, as one unit.
 *
 * They are created and disposed together in all three places the runtime
 * touches them — startup, a failed start, and shutdown — and each was its own
 * field, its own line in the `active` record, and its own `?.dispose()` in two
 * separate paths. That is five edits to add a fourth hook, and the failure
 * mode of missing one is a listener that outlives its transport.
 *
 * Every hook is optional on the facade: a fake that omits one keeps working,
 * and a missing hook is a no-op rather than an error.
 */
export function subscribeHostToRemote(
  host: ForgeHostFacade,
  controller: RemoteController,
  handlers: HostSubscriptionHandlers,
): HostSubscriptions {
  const subscriptions = [
    host.onCompactionEvent?.((event) => handlers.onCompaction(event)),
    // No trigger filter, unlike compaction: every notify_user call is
    // explicitly agent-authored and addressed to the user.
    host.onUserNotification?.(async (event) =>
      event.conversationId === undefined
        ? 0
        : controller.enqueueHostNotification(event.conversationId, event.text),
    ),
    // Window-scoped when the event names no conversation (a model unloaded
    // affects every bound chat here), conversation-scoped when it does. The
    // turn echo arrives on this hook too and routes through mirrorTurn, so a
    // prompt that came from a chat is not answered there twice.
    host.onHostActivity?.((event: HostActivityEvent) => {
      void routeHostActivity(event, controller).catch((err) => {
        handlers.onActivityError((err as Error).message);
      });
    }),
  ];
  return {
    dispose: () => {
      for (const subscription of subscriptions) subscription?.dispose();
    },
  };
}
