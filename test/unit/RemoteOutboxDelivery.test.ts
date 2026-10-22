import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteOutboxDelivery } from '../../src/remote/RemoteOutboxDelivery';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outbox-delivery-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

async function addMessages(
  state: RemoteRequestStore,
  count: number,
  options: { ephemeralAt?: number } = {},
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await state.notifyOutbox('fake', 'chat-1', `message ${String(index)}\nsecond line`, {
      ephemeral: index === options.ephemeralAt,
    });
  }
}

function delivery(
  channel: FakeRemoteChannel,
  state: RemoteRequestStore,
  maxBacklog = 5,
  onError = vi.fn(),
): RemoteOutboxDelivery {
  return new RemoteOutboxDelivery(
    channel,
    state,
    2_000,
    new AbortController().signal,
    10_000,
    onError,
    async () => true,
    undefined,
    undefined,
    maxBacklog,
  );
}

describe('RemoteOutboxDelivery unlock backlog cap', () => {
  it('summarizes 13 held messages, then delivers the newest five in order', async () => {
    const state = await store();
    const channel = new FakeRemoteChannel();
    await addMessages(state, 18);
    const outbox = delivery(channel, state);

    outbox.start();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(6));
    await outbox.stop();

    expect(channel.sent[0]?.text).toContain('Forge: 13 earlier messages were held back');
    for (let index = 1; index <= 13; index += 1) {
      expect(channel.sent[0]?.text).toContain(`message ${String(index)}`);
    }
    expect(channel.sent.slice(1).map((message) => message.text)).toEqual([
      'message 14\nsecond line',
      'message 15\nsecond line',
      'message 16\nsecond line',
      'message 17\nsecond line',
      'message 18\nsecond line',
    ]);
    const records = state.contactRead((snapshot) => snapshot.outbox);
    expect(records.slice(0, 13).every((item) => item.state === 'coalesced')).toBe(true);
    expect(records.slice(13).every((item) => item.state === 'delivered')).toBe(true);
  });

  it('omits ephemeral lines from the summary and preserves an uncapped backlog', async () => {
    const state = await store();
    const channel = new FakeRemoteChannel();
    await addMessages(state, 7, { ephemeralAt: 2 });
    const outbox = delivery(channel, state);

    outbox.start();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(6));
    await outbox.stop();

    expect(channel.sent[0]?.text).toContain('message 1');
    expect(channel.sent[0]?.text).not.toContain('message 2');
    expect(channel.sent[0]?.text).not.toContain('second line');
    expect(channel.sent.slice(1).map((message) => message.text)).toEqual([
      'message 3\nsecond line',
      'message 4\nsecond line',
      'message 5\nsecond line',
      'message 6\nsecond line',
      'message 7\nsecond line',
    ]);

    const uncappedState = await store();
    const uncappedChannel = new FakeRemoteChannel();
    await addMessages(uncappedState, 5);
    const uncapped = delivery(uncappedChannel, uncappedState);
    uncapped.start();
    await vi.waitFor(() => expect(uncappedChannel.sent).toHaveLength(5));
    await uncapped.stop();
    expect(uncappedChannel.sent.map((message) => message.text)).toEqual(
      Array.from({ length: 5 }, (_, index) => `message ${String(index + 1)}\nsecond line`),
    );
  });

  it('restores all coalesced records when sending the summary fails', async () => {
    const state = await store();
    const channel = new FakeRemoteChannel();
    const onError = vi.fn();
    channel.sendError = 'summary failed';
    await addMessages(state, 18);
    const outbox = delivery(channel, state, 5, onError);

    outbox.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await outbox.stop();

    expect(state.contactRead((snapshot) => snapshot.outbox).every((item) => item.state === 'pending'))
      .toBe(true);
  });
});
