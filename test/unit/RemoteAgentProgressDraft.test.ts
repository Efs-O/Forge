import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { CLOCK_INTERVAL_MS, RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import { RemoteDraftRegistry } from '../../src/remote/RemoteDraftRegistry';
import type { RichDraftTransport } from '../../src/remote/telegramRichDraft';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Phase 2: the progress lifecycle on the rich-draft lane.
 *
 * A draft is not a message: it has no message id, it is addressed by
 * `draft_id`, and it expires on Telegram's side in roughly 30 seconds. So the
 * lifecycle has to (a) animate with one reused id, (b) never treat the preview
 * as the answer, and (c) end with a *persistent* status message that the
 * existing transient-cleanup policy can still arm.
 */

interface DraftCall {
  draftId: number;
  text: string;
}

function draftTransport(overrides: Partial<RichDraftTransport> = {}) {
  const updates: DraftCall[] = [];
  const finalizes: Array<{ chatId: string; text: string }> = [];
  const richDraft: RichDraftTransport = {
    beginDraft: async () => ({ kind: 'open', draftId: 42 }),
    updateDraft: async (_chatId, draftId, text) => {
      updates.push({ draftId, text });
    },
    finalizeStatus: async (chatId, text) => {
      finalizes.push({ chatId, text });
      return 'final-7';
    },
    ...overrides,
  };
  return { richDraft, updates, finalizes };
}

function channelWithDrafts(richDraft: RichDraftTransport): FakeRemoteChannel {
  const channel = new FakeRemoteChannel();
  channel.richDraft = richDraft;
  return channel;
}

describe('RemoteAgentProgress on the rich-draft lane', () => {
  it('registers the draft so a Stop update can resolve it back to the conversation', () => {
    const drafts = new RemoteDraftRegistry();
    const { richDraft } = draftTransport();
    const progress = new RemoteAgentProgress(
      channelWithDrafts(richDraft),
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
      undefined,
      undefined,
      CLOCK_INTERVAL_MS,
      drafts,
    );

    progress.begin('c1', 'chat-a', 'draft-42', 'remote', 42);

    expect(drafts.find('chat-a', 42)).toEqual({
      chatId: 'chat-a',
      conversationId: 'c1',
      draftId: 42,
    });
  });

  it('coalesces updates and reuses the same draft_id, never editing a message', async () => {
    vi.useFakeTimers();
    const { richDraft, updates } = draftTransport();
    const channel = channelWithDrafts(richDraft);
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
    );
    progress.begin('c1', 'chat-a', 'draft-42', 'remote', 42);

    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'write_file' });
    await vi.advanceTimersByTimeAsync(999);
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ draftId: 42 });
    expect(updates[0]?.text).toContain('Running write_file…');

    progress.handle({ conversationId: 'c1', kind: 'status', text: 'Running tests…' });
    await vi.advanceTimersByTimeAsync(1_000);
    // One id for the whole turn: Telegram animates changes that share it.
    expect(updates.map((u) => u.draftId)).toEqual([42, 42]);
    // The draft lane must not also edit a message that was never opened.
    expect(channel.edits).toEqual([]);
  });

  it('does not let a narration overtake a draft update already in flight', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const richDraft: RichDraftTransport = {
      beginDraft: async () => ({ kind: 'open', draftId: 42 }),
      updateDraft: async () => {
        order.push('draft');
        await blocked;
      },
      finalizeStatus: async () => undefined,
    };
    const channel = channelWithDrafts(richDraft);
    channel.send = async (chatId: string, text: string): Promise<string[]> => {
      order.push('narration');
      channel.sent.push({ chatId, text });
      return ['n'];
    };
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
    );
    progress.begin('c1', 'chat-a', 'draft-42', 'remote', 42);

    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_000);
    // The draft update is now in flight and unresolved.
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Reading it now.' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(['draft']);

    release?.();
    await vi.advanceTimersByTimeAsync(0);

    // Same tail, so the narration waits its turn instead of jumping ahead of
    // the bubble update that preceded it.
    expect(order).toEqual(['draft', 'narration']);
  });

  it('finalizes with a persistent status message and arms its deletion', async () => {
    vi.useFakeTimers();
    const { richDraft, finalizes } = draftTransport();
    const drafts = new RemoteDraftRegistry();
    const armAfter = vi.fn();
    const channel = channelWithDrafts(richDraft);
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
      undefined,
      armAfter,
      CLOCK_INTERVAL_MS,
      drafts,
    );
    progress.begin('c1', 'chat-a', 'draft-42', 'remote', 42);

    await progress.finish('c1', 'Forge: completed.');

    // The preview expires; this send is what leaves a status in the chat.
    expect(finalizes).toEqual([{ chatId: 'chat-a', text: 'Forge: completed.' }]);
    expect(channel.edits).toEqual([]);
    expect(armAfter).toHaveBeenCalledWith('chat-a', ['final-7'], 10);
    // The draft is no longer a cancel path once the turn is over.
    expect(drafts.find('chat-a', 42)).toBeUndefined();
  });

  it('reports a failed finalize instead of pretending the turn was finalized', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const { richDraft } = draftTransport({
      finalizeStatus: async () => {
        throw new Error('Telegram Bot API HTTP 502.');
      },
    });
    const armAfter = vi.fn();
    const progress = new RemoteAgentProgress(
      channelWithDrafts(richDraft),
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
      (message) => errors.push(message),
      armAfter,
      CLOCK_INTERVAL_MS,
    );
    progress.begin('c1', 'chat-a', 'draft-42', 'remote', 42);

    await progress.finish('c1', 'Forge: completed.');

    // A different sentence from a failed update: the preview expires and the
    // turn leaves no status behind.
    expect(errors[0]).toContain('could not be finalized');
    expect(errors[0]).toContain('502');
    // Nothing to arm — no persistent message exists.
    expect(armAfter).not.toHaveBeenCalled();
  });

  it('refreshes the clock on a draft-only transport that cannot edit messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { richDraft, updates } = draftTransport();
    const channel = channelWithDrafts(richDraft);
    // A transport with no message to edit: the draft preview is the only
    // progress surface it has, so the clock has to move on the draft lane.
    channel.editMessage = undefined;
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000_000,
      undefined,
      undefined,
      CLOCK_INTERVAL_MS,
    );
    progress.begin('c1', 'chat-a', 'draft-42', 'remote', 42);

    // A quiet turn: no events at all, only elapsed time. If the draft lane did
    // not count as updatable, this transport would never refresh its own clock.
    await vi.advanceTimersByTimeAsync(20_000);
    const quietRefreshes = updates.length;
    expect(quietRefreshes).toBeGreaterThan(0);
    expect(updates.every((u) => u.draftId === 42)).toBe(true);

    // The cadence is the draft heartbeat, not the 60s clock. A preview lives
    // roughly 30s on Telegram side, so a quiet turn has to be re-sent more than
    // once a minute or the preview - and its Stop button - vanishes mid-turn.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(updates.length).toBeGreaterThan(quietRefreshes);

    // An event still reaches the preview, and nothing goes down the edit lane.
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'run_build' });
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(updates.at(-1)?.text).toContain('Running run_build\u2026');
    expect(updates.at(-1)?.text).toContain('\u23F1');
    expect(channel.edits).toEqual([]);
  });

  it('forgets the draft when the conversation is replaced or disposed', async () => {
    vi.useFakeTimers();
    const { richDraft } = draftTransport();
    const drafts = new RemoteDraftRegistry();
    const progress = new RemoteAgentProgress(
      channelWithDrafts(richDraft),
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
      undefined,
      undefined,
      CLOCK_INTERVAL_MS,
      drafts,
    );
    progress.begin('c1', 'chat-a', 'draft-42', 'remote', 42);
    progress.begin('c1', 'chat-a', 'draft-43', 'remote', 43);
    expect(drafts.find('chat-a', 42)).toBeUndefined();
    expect(drafts.find('chat-a', 43)?.conversationId).toBe('c1');

    await progress.dispose();
    expect(drafts.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the plain lane untouched for a channel without rich drafts', async () => {
    vi.useFakeTimers();
    const channel = new FakeRemoteChannel();
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
    );
    progress.begin('c1', 'chat-a', 'message-1');
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_000);
    await progress.finish('c1', 'Forge: completed.');

    expect(channel.edits).toHaveLength(2);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: 'Forge: completed.',
    });
  });
});
