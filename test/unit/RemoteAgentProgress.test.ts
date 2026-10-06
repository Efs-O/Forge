import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { CLOCK_INTERVAL_MS, RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import {
  formatElapsed,
  formatLastActivity,
  renderProgressFooter,
} from '../../src/remote/remoteProgressRender';
import { summarizeCliProgress } from '../../src/sidebar/AgentProgress';

afterEach(() => {
  vi.useRealTimers();
});

function rig(editIntervalMs = 1_000, clockIntervalMs = CLOCK_INTERVAL_MS) {
  const channel = new FakeRemoteChannel();
  const armAfter = vi.fn();
  const progress = new RemoteAgentProgress(
    channel,
    new AbortController().signal,
    () => true,
    3_900,
    editIntervalMs,
    undefined,
    armAfter,
    clockIntervalMs,
  );
  progress.begin('c1', 'chat-a', 'message-1');
  return { channel, progress, armAfter };
}

describe('RemoteAgentProgress', () => {
  it('redacts raw CLI commands and file arguments from milestones', () => {
    expect(summarizeCliProgress('codex', '[codex: exec npm test -- --token secret]')).toBe(
      'codex: running a command…',
    );
    expect(summarizeCliProgress('claude', '[claude: Read C:\\private\\secret.txt]')).toBe(
      'claude: reading files…',
    );
  });

  it('streams words into the bubble with the status footer, coalesced', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig();

    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'I read the file. ' });
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'Now I will update it.' });
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file{"secret":1}' });

    await vi.advanceTimersByTimeAsync(999);
    expect(channel.edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(channel.edits).toEqual([
      {
        chatId: 'chat-a',
        messageId: 'message-1',
        text: 'I read the file. Now I will update it.\n\n⏳ Running read_file… · <1 min · 1 tool call · last activity 1 s ago',
      },
    ]);
    expect(channel.stopButtons.has('message-1')).toBe(true);

    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits).toHaveLength(2);
    expect(channel.edits.at(-1)?.text).toContain('2 tool calls');
  });

  it('gives a narration that did not stream a bubble of its own, once', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig();

    // X, then a different Y, then X again: the middle round changes the text,
    // so a guard that only compares against the immediately preceding
    // narration would show X twice. The seen-set must not.
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Let me read the file.' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Now let me update it.' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Let me read the file.' });
    await vi.advanceTimersByTimeAsync(1_000);

    // The first fills the status-only bubble; the second is a new message, so
    // the phone is notified; the repeat is dropped.
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: 'Let me read the file.',
    });
    expect(channel.progress.map((p) => p.text.split('\n')[0])).toEqual(['Now let me update it.']);
    expect(channel.sent).toEqual([]);
  });

  it('sends a warning as its own message as well as latching it in the footer', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig();
    const warning = 'agent is repeating the same tool call — stopping to avoid a loop';

    progress.handle({ conversationId: 'c1', kind: 'notice', severity: 'warning', text: warning });
    await vi.advanceTimersByTimeAsync(1_000);

    // The message is the only half of this that reaches a phone.
    expect(channel.sent).toEqual([{ chatId: 'chat-a', text: `⚠ ${warning}` }]);
    // The status-only bubble above the warning goes; the footer, with its
    // standing copy of the warning, moves below it.
    expect(channel.deleted).toEqual([{ chatId: 'chat-a', messageId: 'message-1' }]);
    expect(channel.progress.at(-1)?.text).toContain(`⚠ ${warning}\n⏳ Forge: working…`);
    const deleted = new Set(channel.deleted.map((d) => d.messageId));
    expect([...channel.stopButtons].filter((id) => !deleted.has(id))).toEqual(['1']);

    // The consecutive-duplicate guard still covers the send.
    progress.handle({ conversationId: 'c1', kind: 'notice', severity: 'warning', text: warning });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.sent).toHaveLength(1);

    // An info notice is a milestone, not news: it stays an edit.
    progress.handle({
      conversationId: 'c1',
      kind: 'notice',
      severity: 'info',
      text: 'compacting the conversation',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.sent).toHaveLength(1);
    expect(channel.edits.at(-1)?.text).toContain('compacting the conversation');
  });

  it('shows a startup phase while the backend loads, then restores the default', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig();

    progress.handle({ conversationId: 'c1', kind: 'phase', text: 'Forge: loading the model…' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits).toEqual([
      {
        chatId: 'chat-a',
        messageId: 'message-1',
        text: '⏳ Forge: loading the model… · <1 min · 0 tool calls · last activity 1 s ago',
      },
    ]);

    progress.handle({ conversationId: 'c1', kind: 'phase', text: undefined });
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'On it.' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: 'On it.\n\n⏳ Forge: working… · <1 min · 0 tool calls · last activity 1 s ago',
    });
  });

  it('ignores events without an active remote request and suppresses edits while locked', async () => {
    vi.useFakeTimers();
    const channel = new FakeRemoteChannel();
    let authenticated = false;
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => authenticated,
      3_900,
      100,
    );

    progress.handle({ conversationId: 'local', kind: 'commentary', text: 'local text' });
    progress.begin('remote', 'chat-a', 'message-1');
    progress.handle({ conversationId: 'remote', kind: 'phase', text: 'private update' });
    await vi.advanceTimersByTimeAsync(100);
    expect(channel.edits).toEqual([]);

    authenticated = true;
    progress.handle({ conversationId: 'remote', kind: 'status', text: 'Running tests…' });
    await vi.advanceTimersByTimeAsync(100);
    expect(channel.edits).toHaveLength(1);
    expect(channel.edits[0]?.text).toContain('private update');
    expect(channel.edits[0]?.text).not.toContain('local text');
  });

  it('cancels a pending update before writing the terminal state', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig();
    progress.handle({ conversationId: 'c1', kind: 'status', text: 'late update' });

    await progress.finish('c1', 'Forge: completed.');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(channel.edits).toEqual([
      { chatId: 'chat-a', messageId: 'message-1', text: 'Forge: completed.' },
    ]);
    expect(channel.stopButtons.size).toBe(0);
  });

  it('latches warnings so a milestone does not overwrite them', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig();

    // The case that motivated this: the repeated-tool-call guard ends the
    // useful part of a turn, and used to say nothing at all remotely.
    progress.handle({
      conversationId: 'c1',
      kind: 'notice',
      severity: 'warning',
      text: 'Forge: agent is repeating the same tool call — stopping to avoid a loop.',
    });
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_000);

    const text = channel.progress.at(-1)!.text;
    expect(text).toContain('⚠ Forge: agent is repeating the same tool call');
    expect(text).toContain('Running read_file…');
  });

  it('replaces the milestone with an info notice but does not latch it', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig();

    progress.handle({
      conversationId: 'c1',
      kind: 'notice',
      severity: 'info',
      text: 'Compacting conversation…',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits.at(-1)!.text).toContain('Compacting conversation…');

    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits.at(-1)!.text).not.toContain('Compacting conversation…');
  });

  it('does not repeat a warning that fires on consecutive rounds', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig();

    for (let round = 0; round < 3; round += 1) {
      progress.handle({
        conversationId: 'c1',
        kind: 'notice',
        severity: 'warning',
        text: 'the same warning',
      });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    const occurrences = channel.progress.at(-1)!.text.split('the same warning').length - 1;
    expect(occurrences).toBe(1);
    expect(channel.sent).toHaveLength(1);
  });

  it('arms deletion of a finished status-only bubble at the fixed queued-ack delay', async () => {
    vi.useFakeTimers();
    const { progress, armAfter } = rig();

    await progress.finish('c1', 'Forge: completed.');

    expect(armAfter).toHaveBeenCalledWith('chat-a', ['message-1'], 10);
  });

  it('keeps a finished bubble that carries the agent words, and arms nothing', async () => {
    vi.useFakeTimers();
    const { channel, progress, armAfter } = rig();
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Done with the edit.' });
    await vi.advanceTimersByTimeAsync(1_000);

    await progress.finish('c1', 'Forge: completed.');

    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: 'Done with the edit.',
    });
    expect(channel.stopButtons.size).toBe(0);
    expect(armAfter).not.toHaveBeenCalled();
  });

  it('finishes without arming deletion when no armAfter callback is wired', async () => {
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

    await expect(progress.finish('c1', 'Forge: completed.')).resolves.toBeUndefined();
  });

  it('formats the elapsed time and activity age', () => {
    expect(formatElapsed(59_999)).toBe('<1 min');
    expect(formatElapsed(4 * 60_000)).toBe('4 min');
    expect(formatElapsed(65 * 60_000)).toBe('1 h 05 min');
    expect(formatLastActivity(59_999)).toBe('59 s');
    expect(formatLastActivity(4 * 60_000)).toBe('4 min');
  });

  it('silently edits the clock once per interval and keeps the status line on truncation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { channel, progress } = rig(1_000);
    await vi.advanceTimersByTimeAsync(30_000);
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'run_build' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits).toHaveLength(1);

    // 61 s in: the clock ticks at 60 s and its refresh lands a second later.
    await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS - 31_000 + 1_000);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: '⏳ Running run_build… · 1 min · 1 tool call · last activity 31 s ago',
    });
    expect(channel.sent).toEqual([]);

    const truncated = renderProgressFooter(
      {
        warnings: ['first warning '.repeat(10)],
        milestone: 'Running tool…',
        startedAt: 0,
        lastActivityAt: 0,
        toolCalls: 2,
      },
      90,
      60_000,
    );
    expect(truncated.length).toBeLessThanOrEqual(90);
    expect(truncated).toContain('· 1 min · 2 tool calls · last activity 1 min ago');
  });

  it('counts every tool and treats reasoning as activity only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { channel, progress } = rig(120_000);
    const events = [
      { conversationId: 'c1', kind: 'tool', toolName: 'read_file' },
      { conversationId: 'c1', kind: 'status', text: 'working' },
      { conversationId: 'c1', kind: 'phase', text: 'Thinking' },
      { conversationId: 'c1', kind: 'notice', severity: 'info', text: 'compacting' },
      { conversationId: 'c1', kind: 'reasoning' },
      { conversationId: 'c1', kind: 'tool', toolName: 'write_file' },
    ] as const;
    for (const event of events) {
      vi.setSystemTime(Date.now() + 1_000);
      progress.handle(event);
    }
    await vi.advanceTimersByTimeAsync(120_000);

    const bubble = channel.edits.at(-1)?.text ?? '';
    expect(bubble).toContain('2 tool calls');
    expect(bubble).toContain('last activity 2 min ago');
    expect(bubble).not.toContain('reasoning');
    expect(channel.sent).toEqual([]);
  });

  it('clears timers on finish, dispose and replacement, and does not start one without edits', async () => {
    vi.useFakeTimers();
    const { channel, progress } = rig(1_000, 1_000);
    await progress.finish('c1', 'Forge: completed.');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channel.edits).toHaveLength(1);

    progress.begin('c2', 'chat-a', 'message-2');
    progress.begin('c2', 'chat-a', 'message-3');
    await vi.advanceTimersByTimeAsync(2_000);
    // Only the replacement refreshes.
    expect(channel.edits.slice(1).map((e) => e.messageId)).toEqual(['message-3']);
    await progress.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channel.edits).toHaveLength(2);

    const noEditChannel = new FakeRemoteChannel();
    noEditChannel.editMessage = undefined;
    const noEditProgress = new RemoteAgentProgress(
      noEditChannel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
      undefined,
      undefined,
      1_000,
    );
    noEditProgress.begin('c3', 'chat-a', 'message-4');
    expect(vi.getTimerCount()).toBe(0);
    await noEditProgress.dispose();
  });
});
