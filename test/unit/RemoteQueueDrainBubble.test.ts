import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callIndex, traceChatCalls } from '../support/chatCalls';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress, CLOCK_INTERVAL_MS } from '../../src/remote/RemoteAgentProgress';
import { drainRemoteQueue, type RemoteQueueDrainDeps } from '../../src/remote/RemoteQueueDrain';
import { RemoteOutboxDelivery } from '../../src/remote/RemoteOutboxDelivery';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { QUEUED_ACK_DELETE_SECONDS } from '../../src/remote/TelegramAcknowledgement';
import type { RemoteRequestRecord } from '../../src/remote/types';
import { CONVERSATION_GONE_ERROR } from '../../src/sidebar/SendPipeline';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

/**
 * The queue-drain seam on the turn's status bubble.
 *
 * The drain opens the turn's first bubble, streams the turn into it, and closes
 * it. Two invariants are under test here and they are not the same one:
 *
 * 1. Separation. The status is one message, the answer is another, and neither
 *    is allowed to become the other. A status in a draft was re-typed letter by
 *    letter; editing the streamed words into the answer would duplicate it,
 *    arrive with no notification, and skip the outbox's retry, speed line,
 *    identity header and reply ids.
 * 2. Order. The answer has to be on screen BEFORE the drain tears the streamed
 *    bubbles down. Delivered first, deleted second is the whole of the fix for
 *    the owner's "the instant the reply finishes my own message drops to the
 *    bottom and the answer lands below it".
 *
 * The outbox here is the real delivery loop, not a stub: the order is only
 * meaningful if the delivery really happens inside the drain's `finally`, and
 * `flush` is what makes it awaitable. Every chat call is recorded in the order
 * it happened, so a "before/after" claim is checkable rather than inferred.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-draintest-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

function request(overrides: Partial<RemoteRequestRecord> = {}): RemoteRequestRecord {
  return {
    id: 'r1',
    dedupKey: 'dedup-1',
    channel: 'telegram',
    chatId: 'chat-1',
    providerMessageId: 'message-1',
    conversationId: 'c1',
    text: 'hello',
    receivedAt: 1,
    state: 'queued',
    updatedAt: 1,
    ...overrides,
  };
}

interface DrainRig {
  state: RemoteRequestStore;
  channel: FakeRemoteChannel;
  calls: string[];
  armAfter: ReturnType<typeof vi.fn>;
  progress: RemoteAgentProgress;
}

async function drainWith(
  outcome:
    | { kind: 'completed'; finalText: string }
    | { kind: 'cancelled'; finalText?: string }
    | { kind: 'failed'; error: string },
  canDeliver: () => Promise<boolean> = async () => true,
  duringTurn?: (progress: RemoteAgentProgress) => Promise<void>,
): Promise<DrainRig> {
  const state = await store();
  await state.enqueue(request());

  const channel = new FakeRemoteChannel('telegram');
  const calls = traceChatCalls(channel);
  const armAfter = vi.fn();
  const signal = new AbortController().signal;
  // A 0 ms edit interval: a test that wants the streamed words on screen has to
  // let the throttle fire inside the turn, and one that has no events is
  // unaffected by it.
  const progress = new RemoteAgentProgress(
    channel,
    signal,
    () => true,
    3_900,
    0,
    undefined,
    armAfter,
    CLOCK_INTERVAL_MS,
  );
  const host = {
    send: vi.fn(async () => {
      await duringTurn?.(progress);
      return outcome;
    }),
    cancel: vi.fn(),
    status: () => ({
      activeConversationId: 'c1',
      conversations: [{ id: 'c1', title: 'Remote', activeModel: 'local', archived: false }],
      requestChains: [],
      streamingConversationIds: [],
    }),
  } as unknown as ForgeHostFacade;

  const outbox = new RemoteOutboxDelivery(channel, state, 3_900, signal, 1_000, undefined, () =>
    canDeliver(),
  );
  const deps = {
    signal,
    channel,
    store: state,
    auth: { canDeliver },
    host,
    progress,
    outbox,
    activeConversations: new Set<string>(),
    attachmentStore: () => undefined,
    isBusy: () => false,
  } as unknown as RemoteQueueDrainDeps;

  await drainRemoteQueue('c1', deps);
  return { state, channel, calls, armAfter, progress };
}

describe('queue drain status bubble', () => {
  it('opens a plain bubble, delivers the answer, then deletes the working line', async () => {
    const { state, channel, calls, armAfter } = await drainWith({
      kind: 'completed',
      finalText: 'Here is the answer.',
    });

    expect(channel.progress).toEqual([{ chatId: 'chat-1', text: 'Forge: working…' }]);
    // The answer first, then the teardown, and no status message in between:
    // the reply is on screen before the line the owner was reading goes.
    expect(calls).toEqual(['progress Forge: working…', 'send Here is the answer.', 'delete 1']);
    // Nothing was ever edited into an outcome line, so nothing is left to delete
    // ten seconds later.
    expect(channel.edits).toEqual([]);
    expect(armAfter).not.toHaveBeenCalled();
    // The answer is delivered once, on its own durable path, and leaves the queue.
    expect(state.pendingOutbox()).toEqual([]);
    expect(channel.sent.map((item) => item.text)).toEqual(['Here is the answer.']);
    expect(channel.edits.map((e) => e.text).join('\n')).not.toContain('Here is the answer.');
  });

  it('keeps audio source bytes out of the model attachment list while preserving its prompt path', async () => {
    const state = await store();
    const image = {
      name: 'still.jpg',
      mediaType: 'image/jpeg',
      relativePath: 'conversation/request/still.jpg',
      bytes: 12,
    };
    const audio = {
      name: 'voice.ogg',
      mediaType: 'audio/ogg',
      relativePath: 'conversation/request/voice.ogg',
      bytes: 20,
    };
    await state.enqueue(
      request({
        text: 'Use .forge/remote-inbox/conversation/request/voice.ogg as source_audio_path.',
        attachments: [image, audio],
      }),
    );
    const channel = new FakeRemoteChannel('telegram');
    const signal = new AbortController().signal;
    const progress = new RemoteAgentProgress(channel, signal, () => true, 3_900, 0);
    const loaded: RemoteRequestRecord['attachments'][] = [];
    const received: Array<unknown[] | undefined> = [];
    const host = {
      send: async (_conversationId: string, _text: string, attachments?: unknown[]) => {
        received.push(attachments);
        return { kind: 'completed' as const, finalText: 'Done.' };
      },
      cancel: async () => undefined,
      status: () => ({
        activeConversationId: 'c1',
        conversations: [{ id: 'c1', title: 'Remote', activeModel: 'local', archived: false }],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;
    const outbox = new RemoteOutboxDelivery(channel, state, 3_900, signal);
    const attachmentStore = {
      load: async (references: NonNullable<RemoteRequestRecord['attachments']>) => {
        loaded.push(references);
        return references.map((reference) => ({
          name: reference.name,
          mediaType: reference.mediaType,
          data: 'c3RpbGw=',
        }));
      },
    };
    const deps = {
      signal,
      channel,
      store: state,
      auth: { canDeliver: async () => true },
      host,
      progress,
      outbox,
      activeConversations: new Set<string>(),
      attachmentStore: () => attachmentStore,
      isBusy: () => false,
    } as unknown as RemoteQueueDrainDeps;

    await drainRemoteQueue('c1', deps);

    expect(loaded[0]).toEqual([image]);
    expect(received[0]).toHaveLength(1);
    expect(received[0]?.[0]).toMatchObject({ name: 'still.jpg', mediaType: 'image/jpeg' });
  });

  it('deletes the streamed copy only after the answer has landed', async () => {
    const { channel, calls, armAfter } = await drainWith(
      { kind: 'completed', finalText: 'The full answer.' },
      async () => true,
      async (progress) => {
        progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'Reading the file…' });
        // Long enough for the edit throttle to fire, so the words the owner is
        // reading are really on screen before the turn ends.
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    );

    const streamed = callIndex(calls, 'edit 1 Reading the file');
    const answer = callIndex(calls, 'send The full answer.');
    const removed = callIndex(calls, 'delete 1');
    // The streamed words stay on screen until the answer arrives, and go after it.
    expect(answer).toBeGreaterThan(streamed);
    expect(removed).toBeGreaterThan(answer);
    expect(channel.edits.at(-1)?.text).not.toBe('Forge: completed.');
    expect(armAfter).not.toHaveBeenCalled();
    // The streamed copy is not left as a second copy of the answer.
    expect(channel.deleted.map((d) => d.messageId)).toEqual(['1']);
  });

  it('closes a cancelled turn with its own status', async () => {
    const { channel, armAfter } = await drainWith({ kind: 'cancelled' });
    expect(channel.edits.at(-1)?.text).toBe('Forge: cancelled.');
    expect(armAfter).toHaveBeenCalledWith('chat-1', ['1'], QUEUED_ACK_DELETE_SECONDS);
  });

  it('closes a failed turn with a status that is not the error text', async () => {
    const { channel, state } = await drainWith({ kind: 'failed', error: 'backend exploded' });
    expect(channel.edits.at(-1)?.text).toBe('Forge: failed.');
    expect(channel.edits.map((e) => e.text).join('\n')).not.toContain('backend exploded');
    // The error still reaches the user — on the notification path, once, and
    // delivered before the status line is written.
    expect(state.pendingOutbox()).toEqual([]);
    expect(channel.sent.map((item) => item.text)).toEqual([
      'Forge request failed: backend exploded',
    ]);
  });

  it('a bound chat that has closed says what to send next', async () => {
    // What the owner saw in the 0.17.117 live test was the sidebar's sentence,
    // `Forge: the queued conversation is no longer open.`, which names nothing a
    // person looking at a handset recognises. The record keeps that sentence —
    // the two surfaces must not disagree about what happened — and only the
    // reply that has to be acted on is rewritten.
    const { channel, state } = await drainWith({
      kind: 'failed',
      error: CONVERSATION_GONE_ERROR,
    });
    expect(channel.sent.map((item) => item.text)).toEqual([
      'Forge: the chat this Telegram chat was bound to is closed. Send /new for a new chat, or /chats to pick an open one.',
    ]);
    expect(state.getRequest('r1')?.error).toBe(CONVERSATION_GONE_ERROR);
    // It is an actionable notice, not a failure stamp: the working line still
    // closes with its own status, unchanged.
    expect(channel.edits.at(-1)?.text).toBe('Forge: failed.');
    expect(state.pendingOutbox()).toEqual([]);
  });

  it('keeps the outcome line when the answer could not be delivered', async () => {
    // Unlocked long enough to open the bubble, then locked for the delivery:
    // with no answer on screen the outcome line is still the only signal.
    const authChecks = [true, true, true, false, false, false, false];
    const { channel, armAfter, state } = await drainWith(
      { kind: 'completed', finalText: 'Here is the answer.' },
      async () => authChecks.shift() ?? false,
    );

    expect(channel.sent).toEqual([]);
    expect(channel.edits.at(-1)?.text).toBe('Forge: completed.');
    expect(armAfter).toHaveBeenCalledWith('chat-1', ['1'], QUEUED_ACK_DELETE_SECONDS);
    // Nothing was lost: the answer is still queued for when the chat unlocks.
    expect(state.pendingOutbox('telegram')).toEqual([
      expect.objectContaining({ text: expect.stringContaining('Here is the answer.') }),
    ]);
  });

  it('runs without a bubble if the chat locks after claim and queues the answer', async () => {
    const authChecks = [true, true, false];
    const { state, channel } = await drainWith(
      { kind: 'completed', finalText: 'Here is the answer.' },
      async () => authChecks.shift() ?? false,
    );

    expect(channel.progress).toEqual([]);
    expect(state.pendingOutbox('telegram')).toEqual([
      expect.objectContaining({ text: expect.stringContaining('Here is the answer.') }),
    ]);
  });
});
