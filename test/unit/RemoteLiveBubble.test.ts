import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteLiveBubble } from '../../src/remote/RemoteLiveBubble';

afterEach(() => {
  vi.useRealTimers();
});

const FOOTER = '⏳ working';

function rig(
  channel = new FakeRemoteChannel(),
  maxChars = 3_900,
  canDeliver: () => Promise<boolean> = async () => true,
  controller = new AbortController(),
) {
  const report = vi.fn();
  const bubble = new RemoteLiveBubble(
    {
      channel,
      chatId: 'chat-a',
      signal: controller.signal,
      canDeliver,
      maxChars: () => maxChars,
      footer: () => FOOTER,
      intervalMs: 1_000,
      report,
    },
    'm0',
  );
  return { channel, bubble, report, controller };
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

  it('returns every status-only id without editing when the chat locks mid-turn', async () => {
    vi.useFakeTimers();
    let deliverable = true;
    const { channel, bubble } = rig(new FakeRemoteChannel(), 3_900, async () => deliverable);
    deliverable = false;

    await expect(bubble.close('Forge: completed.')).resolves.toEqual(['m0']);
    expect(channel.edits).toEqual([]);
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

  // A question board or an approval card stops the turn until the owner answers
  // it, and lands below the bubble carrying the working line. Telegram never
  // moves a message, so the line has to come off for the length of the wait and
  // reopen as a new message at the bottom: `strand()` alone would put it back
  // under the buttons while the owner is still reading them.

  it('takes the working line off a bubble with words and keeps its Stop button', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    bubble.narrate('Checking the ports.');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits.at(-1)?.text).toBe(`Checking the ports.\n\n${FOOTER}`);
    expect(live(channel)).toEqual(['m0']);

    bubble.suspend();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits.at(-1)?.text).toBe('Checking the ports.');
    // The button stays: an edit that does not re-attach it takes it away, and
    // "Send now" has to keep working while a question is on screen.
    expect(live(channel)).toEqual(['m0']);
    expect(channel.deleted).toEqual([]);

    // The clock, a status change and an immediate flush all draw nothing while
    // the owner is answering, so the line cannot reappear above the board.
    bubble.request();
    await bubble.flushNow();
    await vi.advanceTimersByTimeAsync(6_000);
    // Two edits in all: the footer on, then off. Nothing else was drawn while
    // the owner was answering, and no new message was sent.
    expect(channel.edits).toHaveLength(2);
    expect(channel.progress).toEqual([]);

    bubble.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    // The line reopens as a NEW message at the bottom, and the bubble above the
    // board loses its keyboard, so exactly one Stop button exists at a time.
    // The third edit is the same words with the keyboard taken off.
    expect(channel.progress.at(-1)?.text).toBe(FOOTER);
    expect(channel.edits).toHaveLength(3);
    expect(channel.edits.at(-1)?.text).toBe('Checking the ports.');
    expect(live(channel)).toEqual(['1']);
    expect(bubble.owns('m0') && bubble.owns('1')).toBe(true);
  });

  it('deletes a working line that carried nothing but itself', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    // 'm0' is the opened status bubble: no words, only the working line, which
    // is what the owner sees when the agent asks before it says anything.
    bubble.suspend();
    await vi.advanceTimersByTimeAsync(1_000);
    // Telegram rejects an empty message, so the line goes rather than staying
    // above the buttons with nothing in it.
    expect(channel.deleted).toEqual([{ chatId: 'chat-a', messageId: 'm0' }]);
    expect(channel.edits).toEqual([]);

    bubble.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.progress.at(-1)?.text).toBe(FOOTER);
    expect(live(channel)).toEqual(['1']);
    const statusOnly = await bubble.close();
    expect(statusOnly).toEqual([]);
    // A line that is already gone is not deleted a second time when the turn
    // closes, and its id is not handed to the cleanup scheduler.
    expect(channel.deleted.filter((d) => d.messageId === 'm0')).toHaveLength(1);
    expect(channel.deleted.filter((d) => d.messageId === '1')).toHaveLength(1);
  });

  it('writes no outcome line when the answer is already on screen', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    bubble.narrate('Done.');
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(bubble.close()).resolves.toEqual([]);

    expect(channel.edits.at(-1)?.text).toBe('Done.');
    expect(channel.edits.map((e) => e.text)).not.toContain('Forge: completed.');
    expect(channel.deleted).toEqual([]);
    expect(live(channel)).toEqual([]);
  });

  it('sends the outcome line when the working line went with its own bubble', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    bubble.suspend();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.deleted).toEqual([{ chatId: 'chat-a', messageId: 'm0' }]);

    // The turn fails with nobody answering: the outcome still has to reach the
    // chat, and there is no message left to edit, so it is sent as its own.
    const statusOnly = await bubble.close('Forge: failed.');
    expect(statusOnly).toEqual(['1']);
    expect(channel.progress.at(-1)?.text).toBe('Forge: failed.');
    expect(channel.edits).toEqual([]);
    expect(live(channel)).toEqual([]);
  });

  it('draws nothing and leaves no timer once the turn is cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { channel, bubble } = rig(new FakeRemoteChannel(), 3_900, async () => true, controller);
    bubble.narrate('Half way there.');
    await vi.advanceTimersByTimeAsync(1_000);
    bubble.suspend();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits).toHaveLength(2);

    controller.abort();
    bubble.resume();
    bubble.request();
    await vi.advanceTimersByTimeAsync(6_000);
    // Only the two edits that landed before the abort, and nothing scheduled.
    expect(channel.edits.map((e) => e.text)).toEqual([
      `Half way there.\n\n${FOOTER}`,
      'Half way there.',
    ]);
    expect(channel.progress).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not open a working line for a resume nobody suspended', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    bubble.narrate('Words.');
    await vi.advanceTimersByTimeAsync(1_000);
    // A stale resume — the turn ended, or a new one started for the same
    // conversation while a board was pending — must not put a second working
    // line under a turn that never asked for one.
    bubble.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channel.progress).toEqual([]);
    expect(channel.edits).toHaveLength(1);
  });

  it('removes the Stop button a suspended bubble kept when the turn closes', async () => {
    vi.useFakeTimers();
    const { channel, bubble } = rig();
    bubble.narrate('Paused here.');
    await vi.advanceTimersByTimeAsync(1_000);
    bubble.suspend();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits.at(-1)?.text).toBe('Paused here.');

    await bubble.close('Forge: cancelled.');
    // The last bubble has words, so no outcome line; the button the suspend
    // kept still goes, which is what close() is for — the third edit is the
    // same words with the keyboard taken off.
    expect(channel.edits).toHaveLength(3);
    expect(channel.edits.at(-1)?.text).toBe('Paused here.');
    expect(live(channel)).toEqual([]);
  });
});
