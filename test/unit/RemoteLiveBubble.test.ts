import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteLiveBubble } from '../../src/remote/RemoteLiveBubble';

afterEach(() => {
  vi.useRealTimers();
});

const FOOTER = '⏳ working';

function rig(channel = new FakeRemoteChannel(), maxChars = 3_900) {
  const report = vi.fn();
  const bubble = new RemoteLiveBubble(
    {
      channel,
      chatId: 'chat-a',
      signal: new AbortController().signal,
      canDeliver: async () => true,
      maxChars: () => maxChars,
      footer: () => FOOTER,
      intervalMs: 1_000,
      report,
    },
    'm0',
  );
  return { channel, bubble, report };
}

/** Every text each message id was ever shown, sends and edits alike, in order. */
function history(channel: FakeRemoteChannel): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  const push = (id: string, text: string) => byId.set(id, [...(byId.get(id) ?? []), text]);
  channel.progress.forEach((sent, index) => push(String(index + 1), sent.text));
  for (const edit of channel.edits) push(edit.messageId, edit.text);
  return byId;
}

function live(channel: FakeRemoteChannel): string[] {
  const deleted = new Set(channel.deleted.map((d) => d.messageId));
  return [...channel.stopButtons].filter((id) => !deleted.has(id));
}

describe('RemoteLiveBubble', () => {
  it('never shows a finished block in the next bubble, even for one frame', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();

    bubble.append('Let me get the file');
    await vi.advanceTimersByTimeAsync(1_000);
    bubble.narrate('Let me get the file.');
    bubble.endBlock(); // a tool call
    bubble.append('Found it. ');
    await vi.advanceTimersByTimeAsync(1_000);
    bubble.append('Now editing.');
    await vi.advanceTimersByTimeAsync(1_000);

    const seen = history(channel);
    // The old bubble ends as its words alone: no footer, no keyboard.
    expect(seen.get('m0')?.at(-1)).toBe('Let me get the file.');
    // The new bubble starts from its own first word.
    for (const text of seen.get('1') ?? []) expect(text).not.toContain('Let me get');
    expect(seen.get('1')?.at(-1)).toBe(`Found it. Now editing.\n\n${FOOTER}`);
    expect(live(channel)).toEqual(['1']);
    expect(bubble.owns('m0') && bubble.owns('1')).toBe(true);
  });

  it('keeps an edit that was in flight at a block boundary on its own bubble', async () => {
    vi.useFakeTimers();
    const channel = new FakeRemoteChannel();
    const edit = channel.editMessage!.bind(channel);
    let release: (() => void) | undefined;
    channel.editMessage = async (chatId, messageId, text, options) => {
      if (!release && messageId === 'm0') {
        await new Promise<void>((resolve) => (release = resolve));
      }
      return edit(chatId, messageId, text, options);
    };
    const { bubble } = rig(channel);

    bubble.append('old words');
    await vi.advanceTimersByTimeAsync(1_000); // the edit to m0 is now stuck
    bubble.endBlock();
    bubble.append('new words');
    await vi.advanceTimersByTimeAsync(1_000);
    release!();
    await vi.advanceTimersByTimeAsync(2_000);

    const seen = history(channel);
    for (const text of seen.get('1') ?? []) expect(text).not.toContain('old words');
    expect(seen.get('1')?.at(-1)).toBe(`new words\n\n${FOOTER}`);
    expect(seen.get('m0')?.at(-1)).toBe('old words');
  });

  it('re-sends the newest text after a 429, never the refused snapshot', async () => {
    vi.useFakeTimers();
    const channel = new FakeRemoteChannel();
    const edit = channel.editMessage!.bind(channel);
    let throttled = false;
    channel.editMessage = async (chatId, messageId, text, options) => {
      if (!throttled) {
        throttled = true;
        throw Object.assign(new Error('429'), { retryAfterMs: 3_000 });
      }
      return edit(chatId, messageId, text, options);
    };
    const { bubble, report } = rig(channel);

    bubble.append('one');
    await vi.advanceTimersByTimeAsync(1_000); // refused
    bubble.append(' two');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(channel.edits.map((e) => e.text)).toEqual([`one two\n\n${FOOTER}`]);
    expect(report).not.toHaveBeenCalled();
  });

  it('splits before the limit and moves the footer to the last bubble', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig(new FakeRemoteChannel(), 60);

    bubble.append('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu');
    await vi.advanceTimersByTimeAsync(1_000);
    bubble.narrate('ignored: the block already split');
    await vi.advanceTimersByTimeAsync(1_000);

    for (const texts of history(channel).values()) {
      for (const text of texts) expect(text.length).toBeLessThanOrEqual(60);
    }
    expect(live(channel)).toEqual([String(channel.progress.length)]);
    expect(channel.edits.find((e) => e.messageId === 'm0')?.text).not.toContain(FOOTER);
  });

  it('moves the footer below a message sent out of band', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    bubble.narrate('Drawing it now.');
    await bubble.flushNow();
    await channel.send('chat-a', '🖼 image');
    bubble.strand();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(history(channel).get('m0')?.at(-1)).toBe('Drawing it now.');
    expect(channel.progress.at(-1)?.text).toBe(FOOTER);
    expect(live(channel)).toEqual(['1']);
  });

  it('removes every footer and keyboard at close', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    bubble.narrate('First paragraph.');
    bubble.endBlock();
    await vi.advanceTimersByTimeAsync(1_000);
    bubble.narrate('Second paragraph.');
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(bubble.close('Forge: completed.')).resolves.toEqual([]);

    const seen = history(channel);
    expect(seen.get('m0')?.at(-1)).toBe('First paragraph.');
    expect(seen.get('1')?.at(-1)).toBe('Second paragraph.');
    expect(live(channel)).toEqual([]);
  });

  it('deletes the bubbles of an unfinished block, which arrives as the answer', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig(new FakeRemoteChannel(), 60);
    bubble.narrate('Checked.');
    bubble.endBlock();
    await vi.advanceTimersByTimeAsync(1_000);
    bubble.append('The answer is long enough to be split across two of these bubbles');
    await vi.advanceTimersByTimeAsync(1_000);

    const statusOnly = await bubble.close('Forge: completed.');

    expect(history(channel).get('m0')?.at(-1)).toBe('Checked.');
    // The split-off parts are deleted; the last bubble becomes the terminal line.
    const last = String(channel.progress.length);
    expect(channel.progress.length).toBeGreaterThan(1);
    const split = channel.progress.slice(0, -1).map((_, index) => String(index + 1));
    expect(channel.deleted.map((d) => d.messageId)).toEqual(split);
    expect(statusOnly).toEqual([last]);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: last,
      text: 'Forge: completed.',
    });
    expect(live(channel)).toEqual([]);
  });

  it('keeps refreshing nothing after abandon', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    bubble.append('words');
    bubble.abandon();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channel.edits).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
