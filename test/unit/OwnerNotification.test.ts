import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteAuth } from '../../src/remote/RemoteAuth';
import type { RemoteOutboxDelivery } from '../../src/remote/RemoteOutboxDelivery';
import type { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteChannel } from '../../src/remote/types';
import { deliverOwnerNotification } from '../../src/remote/ownerNotification';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('deliverOwnerNotification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leaves the notification pending when no owner is paired', async () => {
    const auth = { getOwner: vi.fn(async () => undefined) } as unknown as RemoteAuth;
    const store = { notifyOutbox: vi.fn() } as unknown as RemoteRequestStore;
    const outbox = { kick: vi.fn() } as unknown as RemoteOutboxDelivery;

    await expect(
      deliverOwnerNotification(
        { name: 'telegram' } as RemoteChannel,
        auth,
        store,
        outbox,
        'Forge is ready.',
      ),
    ).resolves.toBe(0);

    expect(store.notifyOutbox).not.toHaveBeenCalled();
    expect(outbox.kick).not.toHaveBeenCalled();
  });

  it('kicks delivery only after the durable enqueue resolves', async () => {
    const events: string[] = [];
    const enqueue = deferred<void>();
    const auth = {
      getOwner: vi.fn(async () => {
        events.push('owner resolved');
        return 'owner-chat';
      }),
    } as unknown as RemoteAuth;
    const store = {
      notifyOutbox: vi.fn(async () => {
        events.push('enqueue started');
        await enqueue.promise;
        events.push('enqueued');
      }),
    } as unknown as RemoteRequestStore;
    const outbox = {
      kick: vi.fn(() => events.push('delivery kicked')),
    } as unknown as RemoteOutboxDelivery;

    const delivery = deliverOwnerNotification(
      { name: 'telegram' } as RemoteChannel,
      auth,
      store,
      outbox,
      'Forge is ready.',
    );
    await vi.waitFor(() => expect(events).toEqual(['owner resolved', 'enqueue started']));
    expect(outbox.kick).not.toHaveBeenCalled();

    enqueue.resolve();
    await expect(delivery).resolves.toBe(1);
    expect(events).toEqual(['owner resolved', 'enqueue started', 'enqueued', 'delivery kicked']);
  });
});
