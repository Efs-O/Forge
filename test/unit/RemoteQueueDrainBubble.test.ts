import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress, CLOCK_INTERVAL_MS } from '../../src/remote/RemoteAgentProgress';
import { drainRemoteQueue, type RemoteQueueDrainDeps } from '../../src/remote/RemoteQueueDrain';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteRequestRecord } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

/**
 * The queue-drain seam on the turn's status bubble.
 *
 * The drain opens the turn's first bubble and closes it. That bubble is a
 * plain message edited in place, never a draft: a status in a draft was
 * re-typed letter by letter on every change. The invariant under test is
 * the separation: the status is one message, the answer is another, and
 * neither is allowed to become the other.
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

interface DrainResult {
  state: RemoteRequestStore;
  channel: FakeRemoteChannel;
}

async function drainWith(
  outcome:
    | { kind: 'completed'; finalText: string }
    | { kind: 'cancelled' }
    | { kind: 'failed'; error: string },
): Promise<DrainResult> {
  const state = await store();
  await state.enqueue(request());

  const channel = new FakeRemoteChannel('telegram');

  const progress = new RemoteAgentProgress(
    channel,
    new AbortController().signal,
    () => true,
    3_900,
    1_000,
    undefined,
    undefined,
    CLOCK_INTERVAL_MS,
  );
  const host = {
    send: vi.fn(async () => outcome),
    cancel: vi.fn(),
    status: () => ({
      activeConversationId: 'c1',
      conversations: [{ id: 'c1', title: 'Remote', activeModel: 'local', archived: false }],
      requestChains: [],
      streamingConversationIds: [],
    }),
  } as unknown as ForgeHostFacade;

  const deps = {
    signal: new AbortController().signal,
    channel,
    store: state,
    auth: { canDeliver: async () => true },
    host,
    progress,
    outbox: { kick: () => undefined },
    activeConversations: new Set<string>(),
    attachmentStore: () => undefined,
    isBusy: () => false,
  } as unknown as RemoteQueueDrainDeps;

  await drainRemoteQueue('c1', deps);
  return { state, channel };
}

describe('queue drain status bubble', () => {
  it('opens a plain bubble and closes it with a status, never the answer', async () => {
    const { state, channel } = await drainWith({
      kind: 'completed',
      finalText: 'Here is the answer.',
    });

    expect(channel.progress).toEqual([{ chatId: 'chat-1', text: 'Forge: working…' }]);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-1',
      messageId: '1',
      text: 'Forge: completed.',
    });
    // The answer is delivered once, on its own durable path.
    const outbox = state.pendingOutbox();
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox[0])).toContain('Here is the answer.');
    expect(channel.edits.map((e) => e.text).join('\n')).not.toContain('Here is the answer.');
  });

  it('closes a cancelled turn with its own status', async () => {
    const { channel } = await drainWith({ kind: 'cancelled' });
    expect(channel.edits.at(-1)?.text).toBe('Forge: cancelled.');
  });

  it('closes a failed turn with a status that is not the error text', async () => {
    const { channel, state } = await drainWith({ kind: 'failed', error: 'backend exploded' });
    expect(channel.edits.at(-1)?.text).toBe('Forge: failed.');
    expect(channel.edits.map((e) => e.text).join('\n')).not.toContain('backend exploded');
    // The error still reaches the user — on the notification path, once.
    expect(JSON.stringify(state.pendingOutbox())).toContain('backend exploded');
  });
});
