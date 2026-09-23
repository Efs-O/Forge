import { describe, expect, it } from 'vitest';
import { claimRemoteMidTurnTell, type CanDeliver } from '../../src/remote/RemoteMidTurnTells';
import type { RemoteRequestRecord } from '../../src/remote/types';

/** A just-enough fake of `RemoteRequestStore` for the mid-turn tell claim. */
interface FakeStore {
  records: RemoteRequestRecord[];
  queued(conversationId?: string): RemoteRequestRecord[];
  claimMidTurnTell(id: string): Promise<RemoteRequestRecord | undefined>;
  finish(id: string, state: 'completed', opts?: { notification?: string }): Promise<void>;
}

function makeRecord(overrides: Partial<RemoteRequestRecord> = {}): RemoteRequestRecord {
  return {
    id: 'req-1',
    dedupKey: 'k',
    channel: 'telegram',
    chatId: 'chat-1',
    providerMessageId: 'm-1',
    conversationId: 'conv-1',
    text: 'also update the changelog',
    receivedAt: 1,
    state: 'queued',
    updatedAt: 1,
    ...overrides,
  };
}

function makeStore(records: RemoteRequestRecord[]): FakeStore {
  // `queued()` returns a snapshot taken when the list was read, while
  // `claimMidTurnTell` checks the live state — so a record that is no longer
  // `queued` by claim time is skipped, exactly like the store's serialized
  // mutation. This is what lets the "already claimed" race be exercised.
  const snapshot = records.filter((item) => item.state === 'queued');
  return {
    records,
    queued(conversationId) {
      return snapshot.filter((item) => item.conversationId === conversationId);
    },
    // Atomic: only a record still `queued` is claimed, mirroring the store mutation.
    async claimMidTurnTell(id) {
      const record = records.find((item) => item.id === id);
      if (!record || record.state !== 'queued') return undefined;
      record.state = 'running';
      return structuredClone(record);
    },
    async finish(id, state, opts) {
      const record = records.find((item) => item.id === id);
      if (record) {
        record.state = state;
        record.notification = opts?.notification;
      }
    },
  };
}

const deliverAll: CanDeliver = async () => true;

describe('claimRemoteMidTurnTell', () => {
  it('claims a queued text-only request and finishes it completed after settle', async () => {
    const store = makeStore([makeRecord()]);
    const result = await claimRemoteMidTurnTell(store, deliverAll, 'conv-1');

    expect(result.messages).toEqual([{ role: 'user', content: 'also update the changelog', midTurn: true }]);
    expect(store.records[0]?.state).toBe('running');
    expect(result.settle).toBeDefined();

    await result.settle?.();
    expect(store.records[0]?.state).toBe('completed');
    expect(store.records[0]?.notification).toBe('Seen by the running turn.');
  });

  it('claims every eligible request in queue order and finishes each after settle', async () => {
    const store = makeStore([
      makeRecord({ id: 'req-a', receivedAt: 1, text: 'first' }),
      makeRecord({
        id: 'req-attach',
        receivedAt: 2,
        attachments: [{ name: 'a.png', mediaType: 'image/png', relativePath: 'a.png', bytes: 1 }],
      }),
      makeRecord({ id: 'req-b', receivedAt: 3, text: 'second' }),
    ]);

    const result = await claimRemoteMidTurnTell(store, deliverAll, 'conv-1');

    // Two eligible claims, in queue order; the attachment stays queued.
    expect(result.messages).toEqual([
      { role: 'user', content: 'first', midTurn: true },
      { role: 'user', content: 'second', midTurn: true },
    ]);
    expect(store.records[0]?.state).toBe('running');
    expect(store.records[1]?.state).toBe('queued');
    expect(store.records[2]?.state).toBe('running');
    expect(result.settle).toBeDefined();

    await result.settle?.();
    expect(store.records[0]?.state).toBe('completed');
    expect(store.records[1]?.state).toBe('queued');
    expect(store.records[2]?.state).toBe('completed');
    expect(store.records[0]?.notification).toBe('Seen by the running turn.');
    expect(store.records[2]?.notification).toBe('Seen by the running turn.');
  });

  it('leaves an attachment-carrying request queued', async () => {
    const store = makeStore([
      makeRecord({
        id: 'req-attach',
        attachments: [{ name: 'a.png', mediaType: 'image/png', relativePath: 'a.png', bytes: 1 }],
      }),
    ]);

    const result = await claimRemoteMidTurnTell(store, deliverAll, 'conv-1');

    expect(result.messages).toEqual([]);
    expect(result.settle).toBeUndefined();
    expect(store.records[0]?.state).toBe('queued');
  });

  it('leaves a request from a chat that canDeliver refuses queued', async () => {
    const store = makeStore([makeRecord({ chatId: 'chat-denied' })]);
    const canDeliver: CanDeliver = async (_channel, chatId) => chatId !== 'chat-denied';

    const result = await claimRemoteMidTurnTell(store, canDeliver, 'conv-1');

    expect(result.messages).toEqual([]);
    expect(result.settle).toBeUndefined();
    expect(store.records[0]?.state).toBe('queued');
  });

  it('skips a steer-priority request and claims the next normal one', async () => {
    const store = makeStore([
      makeRecord({ id: 'req-steer', priority: 'steer', text: 'steer me' }),
      makeRecord({ id: 'req-normal', text: 'normal text' }),
    ]);

    const result = await claimRemoteMidTurnTell(store, deliverAll, 'conv-1');

    expect(result.messages).toEqual([{ role: 'user', content: 'normal text', midTurn: true }]);
    expect(store.records[0]?.state).toBe('queued'); // steer left for RemoteQueueDrain
    expect(store.records[1]?.state).toBe('running');
  });

  it('skips a record the drain already claimed and does not inject it', async () => {
    // The record starts queued (so it is a candidate) but is claimed by the
    // drain before the tell claim runs: the atomic re-check must skip it.
    const record = makeRecord({ id: 'req-taken' });
    const store = makeStore([record]);
    record.state = 'running'; // RemoteQueueDrain took it after the snapshot

    const result = await claimRemoteMidTurnTell(store, deliverAll, 'conv-1');

    expect(result.messages).toEqual([]);
    expect(result.settle).toBeUndefined();
    expect(store.records[0]?.state).toBe('running');
  });
});
