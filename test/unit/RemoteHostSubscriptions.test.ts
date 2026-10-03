import { describe, expect, it, vi } from 'vitest';
import type { UserNotificationSink } from '../src/sidebar/UserNotificationService';
import type { ForgeHostFacade } from '../src/sidebar/ForgeHostFacade';
import { subscribeHostToRemote } from '../../src/remote/remoteHostSubscriptions';
import type { RemoteController } from '../src/remote/RemoteController';

/**
 * The production join between `UserNotificationService` and the remote runtime.
 *
 * `RemoteImageDelivery.test.ts` wires a sink *shaped like* this one to prove
 * ordering through `RemoteAgentProgress`. It cannot catch a regression here, in
 * the arm that decides an `imagePath` event goes to `deliverHostImage` rather
 * than `enqueueHostNotification`. This test calls `subscribeHostToRemote`
 * itself, so flipping or dropping that arm fails.
 */
function rig() {
  let sink: UserNotificationSink | undefined;
  const host = {
    onUserNotification: (registered: UserNotificationSink) => {
      sink = registered;
      return { dispose: () => (sink = undefined) };
    },
  } as unknown as ForgeHostFacade;

  const flush = vi.fn(async () => undefined);
  const controller = {
    deliverHostImage: vi.fn(() => 1),
    enqueueHostNotification: vi.fn(async () => 2),
  } as unknown as RemoteController;

  const subscriptions = subscribeHostToRemote(host, controller, {
    onCompaction: vi.fn(),
    onActivityError: vi.fn(),
    onBeforeConversationNotify: async (c, conversationId) => {
      await flush(c, conversationId);
    },
  });
  if (!sink) throw new Error('subscribeHostToRemote did not register a notification sink');
  return { sink, controller, flush, subscriptions };
}

describe('subscribeHostToRemote notification routing', () => {
  it('routes an imagePath event to deliverHostImage, not to the text outbox', async () => {
    const { sink, controller, flush, subscriptions } = rig();
    try {
      const reached = await sink({ conversationId: 'c1', text: 'caption', imagePath: 'a.png' });
      expect(controller.deliverHostImage).toHaveBeenCalledWith('c1', 'a.png', 'caption');
      expect(controller.enqueueHostNotification).not.toHaveBeenCalled();
      expect(reached).toBe(1);
      // The pre-notify flush still runs, so an aggregated notice cannot
      // overtake the file send.
      expect(flush).toHaveBeenCalledWith(controller, 'c1');
    } finally {
      subscriptions.dispose();
    }
  });

  it('routes a text-only event to the durable outbox', async () => {
    const { sink, controller, subscriptions } = rig();
    try {
      expect(await sink({ conversationId: 'c1', text: 'build done' })).toBe(2);
      expect(controller.enqueueHostNotification).toHaveBeenCalledWith('c1', 'build done');
      expect(controller.deliverHostImage).not.toHaveBeenCalled();
    } finally {
      subscriptions.dispose();
    }
  });

  it('reports 0 for a conversation-less event without touching the controller', async () => {
    const { sink, controller, flush, subscriptions } = rig();
    try {
      expect(await sink({ text: 'window-scoped' })).toBe(0);
      expect(controller.deliverHostImage).not.toHaveBeenCalled();
      expect(controller.enqueueHostNotification).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
    } finally {
      subscriptions.dispose();
    }
  });
});
