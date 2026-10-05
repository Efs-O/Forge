import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { CLOCK_INTERVAL_MS, RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import { RemoteDraftRegistry } from '../../src/remote/RemoteDraftRegistry';
import type { DraftOpenOutcome, RichDraftTransport } from '../../src/remote/telegramRichDraft';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The status bubble and the words preview are two surfaces.
 *
 * The status ("Forge: working…", the tool running, the clock) is a plain
 * message edited in place, which Telegram does not animate. Only the model's
 * streamed words go to a rich draft, opened on the first word: Telegram
 * re-types a draft from its first changed character, so a status in a draft
 * crawled letter by letter on every update.
 * See docs/plans/TELEGRAM_STATUS_BUBBLE_RESTORE_PLAN.md.
 */

interface DraftCall {
  draftId: number;
  text: string;
}

function draftTransport(
  open: () => Promise<DraftOpenOutcome> = async () => ({
    kind: 'open',
    draftId: 42,
  }),
) {
  const opens: string[] = [];
  const updates: DraftCall[] = [];
  const richDraft: RichDraftTransport = {
    beginDraft: async (_chatId, text) => {
      opens.push(text);
      return open();
    },
    updateDraft: async (_chatId, draftId, text) => {
      updates.push({ draftId, text });
    },
  };
  return { richDraft, opens, updates };
}

function channelWithDrafts(richDraft: RichDraftTransport): FakeRemoteChannel {
  const channel = new FakeRemoteChannel();
  channel.richDraft = richDraft;
  return channel;
}

function progressFor(
  channel: FakeRemoteChannel,
  options: {
    drafts?: RemoteDraftRegistry;
    armAfter?: (chatId: string, ids: string[], delay: number) => void;
    errors?: string[];
  } = {},
): RemoteAgentProgress {
  return new RemoteAgentProgress(
    channel,
    new AbortController().signal,
    () => true,
    3_900,
    1_500,
    (message) => options.errors?.push(message),
    options.armAfter,
    CLOCK_INTERVAL_MS,
    options.drafts,
  );
}

describe('RemoteAgentProgress: plain status bubble plus a words-only preview', () => {
  it('keeps every status in the edited bubble and opens no draft for it', async () => {
    vi.useFakeTimers();
    const { richDraft, opens, updates } = draftTransport();
    const channel = channelWithDrafts(richDraft);
    const progress = progressFor(channel);
    progress.begin('c1', 'chat-a', 'm1');

    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    progress.handle({ conversationId: 'c1', kind: 'status', text: 'Waiting for approval' });
    progress.handle({ conversationId: 'c1', kind: 'phase', text: 'Forge: compacting…' });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(opens).toEqual([]);
    expect(updates).toEqual([]);
    expect(channel.edits.at(-1)?.messageId).toBe('m1');
    expect(channel.edits.at(-1)?.text).toContain('Waiting for approval');
  });

  it('opens the preview on the first words, with the words only, and registers it', async () => {
    vi.useFakeTimers();
    const drafts = new RemoteDraftRegistry();
    const { richDraft, opens, updates } = draftTransport();
    const channel = channelWithDrafts(richDraft);
    const progress = progressFor(channel, { drafts });
    progress.begin('c1', 'chat-a', 'm1');

    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'The guard ' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opens).toEqual(['The guard']);
    expect(drafts.find('chat-a', 42)).toEqual({
      chatId: 'chat-a',
      conversationId: 'c1',
      draftId: 42,
    });

    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'module is fine.' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'edit_file' });
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: ' Editing it.' });
    await vi.advanceTimersByTimeAsync(1_000);

    const texts = [...opens, ...updates.map((u) => u.text)];
    expect(texts.at(-1)).toBe('The guard module is fine. Editing it.');
    // Append-only, so Telegram animates only the new words.
    for (let i = 1; i < texts.length; i += 1) {
      expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true);
    }
    expect(updates.every((u) => u.draftId === 42)).toBe(true);
    // No status, tool line, headline or clock ever enters the preview.
    expect(texts.join('\n')).not.toMatch(/Running|Forge:|⏱/);
    // And the words never enter the permanent bubble.
    expect(channel.edits.map((e) => e.text).join('\n')).not.toContain('guard');
  });

  it('never holds a narration behind a draft update that is still in flight', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const richDraft: RichDraftTransport = {
      beginDraft: async () => {
        order.push('draft');
        await blocked;
        return { kind: 'open', draftId: 42 };
      },
      updateDraft: async () => undefined,
    };
    const channel = channelWithDrafts(richDraft);
    channel.send = async (chatId: string, text: string): Promise<string[]> => {
      order.push('narration');
      channel.sent.push({ chatId, text });
      return ['n'];
    };
    const progress = progressFor(channel);
    progress.begin('c1', 'chat-a', 'm1');

    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'Reading it now.' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Reading it now.' });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['draft', 'narration']);

    // finish waits for the in-flight preview before closing the bubble.
    let finished = false;
    const finishing = progress.finish('c1', 'Forge: completed.').then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    release?.();
    await finishing;
    expect(finished).toBe(true);
  });

  it('sends a narration once and keeps its words in the preview', async () => {
    vi.useFakeTimers();
    const { richDraft, opens, updates } = draftTransport();
    const channel = channelWithDrafts(richDraft);
    const progress = progressFor(channel);
    progress.begin('c1', 'chat-a', 'm1');

    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'Let me look.' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Let me look.' });
    progress.handle({ conversationId: 'c1', kind: 'reasoning' });
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: ' Final answer.' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(channel.sent.map((m) => m.text)).toEqual(['Let me look.']);
    expect(opens).toEqual(['Let me look.']);
    expect(updates.at(-1)?.text).toBe('Let me look. Final answer.');
  });

  it('streams nothing more this turn once the transport refuses a draft', async () => {
    vi.useFakeTimers();
    const { richDraft, opens, updates } = draftTransport(async () => ({ kind: 'unsupported' }));
    const channel = channelWithDrafts(richDraft);
    const progress = progressFor(channel);
    progress.begin('c1', 'chat-a', 'm1');

    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'one' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: ' two' });
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(opens).toEqual(['one']);
    expect(updates).toEqual([]);
    // The bubble still reports the turn.
    expect(channel.edits.at(-1)?.text).toContain('Running read_file…');
  });

  it('never re-sends unchanged words, and opens a fresh preview after a quiet stretch', async () => {
    vi.useFakeTimers();
    let nextId = 41;
    const { richDraft, opens, updates } = draftTransport(async () => ({
      kind: 'open',
      draftId: ++nextId,
    }));
    const drafts = new RemoteDraftRegistry();
    const progress = progressFor(channelWithDrafts(richDraft), { drafts });
    progress.begin('c1', 'chat-a', 'm1');

    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'Thinking it over.' });
    await vi.advanceTimersByTimeAsync(1_000);
    // A re-send re-types the same words on the phone (the 2026-10-05 replay).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opens).toEqual(['Thinking it over.']);
    expect(updates).toEqual([]);

    // Telegram dropped that preview; the next words stand alone in a new one.
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'Now writing.' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opens).toEqual(['Thinking it over.', 'Now writing.']);
    // The first preview may still be on screen, so its Stop still finds the turn.
    expect(drafts.find('chat-a', 42)?.conversationId).toBe('c1');
    expect(drafts.find('chat-a', 43)?.conversationId).toBe('c1');
    await progress.dispose();
  });

  it('closes the turn on the bubble, forgets the preview and stops its timers', async () => {
    vi.useFakeTimers();
    const drafts = new RemoteDraftRegistry();
    const armAfter = vi.fn();
    const { richDraft, updates } = draftTransport();
    const channel = channelWithDrafts(richDraft);
    const progress = progressFor(channel, { drafts, armAfter });
    progress.begin('c1', 'chat-a', 'm1');
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'Done soon.' });
    await vi.advanceTimersByTimeAsync(1_000);

    await progress.finish('c1', 'Forge: completed.');

    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'm1',
      text: 'Forge: completed.',
    });
    expect(armAfter).toHaveBeenCalledWith('chat-a', ['m1'], 10);
    expect(drafts.size).toBe(0);
    const before = updates.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updates.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not register a preview that finished opening after an unpair', async () => {
    vi.useFakeTimers();
    const drafts = new RemoteDraftRegistry();
    let resolveOpen!: (outcome: DraftOpenOutcome) => void;
    const { richDraft } = draftTransport(
      () => new Promise<DraftOpenOutcome>((resolve) => (resolveOpen = resolve)),
    );
    const progress = progressFor(channelWithDrafts(richDraft), { drafts });
    progress.begin('c1', 'chat-a', 'm1');
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'words' });
    await vi.advanceTimersByTimeAsync(1_000);

    // What RemoteController.forgetChannel does on unpair, mid-open.
    drafts.forgetAll();
    resolveOpen({ kind: 'open', draftId: 42 });
    await vi.advanceTimersByTimeAsync(0);

    expect(drafts.find('chat-a', 42)).toBeUndefined();
    await progress.dispose();
  });

  it('forgets the preview when the conversation is disposed', async () => {
    vi.useFakeTimers();
    const drafts = new RemoteDraftRegistry();
    const { richDraft } = draftTransport();
    const progress = progressFor(channelWithDrafts(richDraft), { drafts });
    progress.begin('c1', 'chat-a', 'm1');
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'words' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drafts.size).toBe(1);

    await progress.dispose();
    expect(drafts.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the plain lane untouched for a channel without rich drafts', async () => {
    vi.useFakeTimers();
    const channel = new FakeRemoteChannel();
    const progress = progressFor(channel);
    progress.begin('c1', 'chat-a', 'message-1');
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'secret words' });
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_500);
    await progress.finish('c1', 'Forge: completed.');

    expect(channel.edits).toHaveLength(2);
    expect(channel.edits.map((e) => e.text).join('\n')).not.toContain('secret words');
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: 'Forge: completed.',
    });
  });
});
