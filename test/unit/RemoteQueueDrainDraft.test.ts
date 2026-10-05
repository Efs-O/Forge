import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress, CLOCK_INTERVAL_MS } from '../../src/remote/RemoteAgentProgress';
import { RemoteDraftRegistry } from '../../src/remote/RemoteDraftRegistry';
import {
  drainRemoteQueue,
  type RemoteQueueDrainDeps,
} from '../../src/remote/RemoteQueueDrain';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RichDraftTransport } from '../../src/remote/telegramRichDraft';
import type { RemoteRequestRecord } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

/**
 * Phase 2 at the queue-drain seam.
 *
 * The drain is what opens a turn's progress bubble, so it is also what must
 * close it — and on the draft lane "close" means *send a persistent status*,
 * because the preview is a ~30-second thing that Telegram keeps nothing of.
 * The invariant under test is the separation: the status is one message, the
 * answer is another, and neither is allowed to become the other.
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
  finalizes: Array<{ chatId: string; text: string }>;
  drafts: RemoteDraftRegistry;
  order: string[];
}

async function drainWithDraft(
  outcome: { kind: 'completed'; finalText: string } | { kind: 'cancelled' } | { kind: 'failed'; error: string },
  options: { withDraft?: boolean } = {},
): Promise<DrainResult> {
  const withDraft = options.withDraft !== false;
  const state = await store();
  await state.enqueue(request());

  const channel = new FakeRemoteChannel('telegram');
  const finalizes: Array<{ chatId: string; text: string }> = [];
  const order: string[] = [];
  if (withDraft) {
    const richDraft: RichDraftTransport = {
      beginDraft: async () => {
        order.push('draft-open');
        return { kind: 'open', draftId: 42 };
      },
      updateDraft: async () => undefined,
      finalizeStatus: async (chatId, text) => {
        order.push('finalize');
        finalizes.push({ chatId, text });
        return 'final-1';
      },
    };
    channel.richDraft = richDraft;
  }

  const drafts = new RemoteDraftRegistry();
  const progress = new RemoteAgentProgress(
    channel,
    new AbortController().signal,
    () => true,
    3_900,
    1_000,
    undefined,
    undefined,
    CLOCK_INTERVAL_MS,
    drafts,
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
  return { state, channel, finalizes, drafts, order };
}

describe('queue drain finalizes the rich draft (Phase 2)', () => {
  it('opens the draft before the turn starts, so a Stop can resolve mid-turn', async () => {
    const state = await store();
    await state.enqueue(request());
    const channel = new FakeRemoteChannel('telegram');
    const drafts = new RemoteDraftRegistry();
    channel.richDraft = {
      beginDraft: async () => ({ kind: 'open', draftId: 7 }),
      updateDraft: async () => undefined,
      finalizeStatus: async () => 'final-1',
    };
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
      undefined,
      undefined,
      CLOCK_INTERVAL_MS,
      drafts,
    );
    let registeredMidTurn: string | undefined;
    const host = {
      send: vi.fn(async () => {
        // The draft must already be addressable while the turn is running —
        // that is the whole window the native Stop button exists for.
        registeredMidTurn = drafts.find('chat-1', 7)?.conversationId;
        return { kind: 'completed' as const, finalText: 'done' };
      }),
      cancel: vi.fn(),
      status: () => ({
        activeConversationId: 'c1',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;

    await drainRemoteQueue('c1', {
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
    } as unknown as RemoteQueueDrainDeps);

    expect(registeredMidTurn).toBe('c1');
    // And not addressable afterwards.
    expect(drafts.size).toBe(0);
  });

  it('finalizes a completed turn with a status message, never the answer', async () => {
    const { state, finalizes, channel } = await drainWithDraft({
      kind: 'completed',
      finalText: 'Here is the answer.',
    });

    expect(finalizes).toEqual([{ chatId: 'chat-1', text: 'Forge: completed.' }]);
    expect(finalizes[0]?.text).not.toContain('Here is the answer.');
    // The draft lane opened no plain bubble and edited no message.
    expect(channel.progress).toEqual([]);
    expect(channel.edits).toEqual([]);
    // The answer is delivered once, on its own durable path.
    const outbox = state.pendingOutbox();
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox[0])).toContain('Here is the answer.');
  });

  it('finalizes a cancelled turn with its own status', async () => {
    const { finalizes } = await drainWithDraft({ kind: 'cancelled' });
    expect(finalizes).toEqual([{ chatId: 'chat-1', text: 'Forge: cancelled.' }]);
  });

  it('finalizes a failed turn with a status that is not the error text', async () => {
    const { finalizes, state } = await drainWithDraft({ kind: 'failed', error: 'backend exploded' });
    expect(finalizes).toEqual([{ chatId: 'chat-1', text: 'Forge: failed.' }]);
    expect(finalizes[0]?.text).not.toContain('backend exploded');
    // The error still reaches the user — on the notification path, once.
    expect(JSON.stringify(state.pendingOutbox())).toContain('backend exploded');
  });

  it('finalizes exactly once per turn', async () => {
    const { finalizes, order } = await drainWithDraft({ kind: 'completed', finalText: 'done' });
    expect(finalizes).toHaveLength(1);
    expect(order.filter((entry) => entry === 'finalize')).toHaveLength(1);
    expect(order).toEqual(['draft-open', 'finalize']);
  });

  it('keeps the plain bubble path for a channel without rich-draft support', async () => {
    const { channel, finalizes } = await drainWithDraft(
      { kind: 'completed', finalText: 'done' },
      { withDraft: false },
    );
    expect(finalizes).toEqual([]);
    expect(channel.progress).toEqual([{ chatId: 'chat-1', text: 'Forge: working…' }]);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-1',
      messageId: '1',
      text: 'Forge: completed.',
    });
  });
});
