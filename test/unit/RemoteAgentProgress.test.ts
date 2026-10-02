import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { CLOCK_INTERVAL_MS, RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import { formatElapsed, formatLastActivity, renderRemoteProgress } from '../../src/remote/remoteProgressRender';
import { summarizeCliProgress } from '../../src/sidebar/AgentProgress';

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteAgentProgress', () => {
  it('redacts raw CLI commands and file arguments from milestones', () => {
    expect(summarizeCliProgress('codex', '[codex: exec npm test -- --token secret]')).toBe(
      'codex: running a command…',
    );
    expect(summarizeCliProgress('claude', '[claude: Read C:\\private\\secret.txt]')).toBe(
      'claude: reading files…',
    );
  });

  it('keeps streamed commentary out of the bubble and coalesces the tool milestone', async () => {
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
        text: 'Forge: working…\n\nRunning read_file…\n\n⏱ <1 min · 1 tool call · last activity 1 s ago',
      },
    ]);

    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits).toHaveLength(2);
    expect(channel.edits.at(-1)?.text).toContain('2 tool calls');
  });

  it('sends a finished mid-turn narration as its own message, never in the bubble', async () => {
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

    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'Let me read the file.' });
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Let me read the file.' });
    await vi.advanceTimersByTimeAsync(1_000);

    // A real message, so the phone raises a notification -- and the bubble
    // never showed that text, so it appears exactly once.
    expect(channel.sent).toEqual([{ chatId: 'chat-a', text: 'Let me read the file.' }]);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: 'Forge: working…\n\nRunning read_file…\n\n⏱ <1 min · 1 tool call · last activity 1 s ago',
    });

    // A round that says the same thing again does not send it twice.
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Let me read the file.' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.sent).toHaveLength(1);
  });

  it('does not send a narration twice when it repeats in non-adjacent rounds', async () => {
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

    // X, then a different Y, then X again: the middle round changes the text,
    // so a guard that only compares against the immediately preceding
    // narration would send X twice. The seen-set must not.
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Let me read the file.' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Now let me update it.' });
    await vi.advanceTimersByTimeAsync(1_000);
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Let me read the file.' });
    await vi.advanceTimersByTimeAsync(1_000);

    // X and Y, not X, Y, X.
    expect(channel.sent).toEqual([
      { chatId: 'chat-a', text: 'Let me read the file.' },
      { chatId: 'chat-a', text: 'Now let me update it.' },
    ]);
  });

  it('sends a warning as its own message as well as latching it in the bubble', async () => {
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

    progress.handle({
      conversationId: 'c1',
      kind: 'notice',
      severity: 'warning',
      text: 'agent is repeating the same tool call — stopping to avoid a loop',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // The message is the only half of this that reaches a phone.
    expect(channel.sent).toEqual([
      {
        chatId: 'chat-a',
        text: '⚠ agent is repeating the same tool call — stopping to avoid a loop',
      },
    ]);
    // The bubble keeps its standing copy: sending does not un-latch it.
    expect(channel.edits.at(-1)?.text).toContain(
      '⚠ agent is repeating the same tool call — stopping to avoid a loop',
    );

    // The existing consecutive-duplicate guard still covers the send.
    progress.handle({
      conversationId: 'c1',
      kind: 'notice',
      severity: 'warning',
      text: 'agent is repeating the same tool call — stopping to avoid a loop',
    });
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
  });

  it('shows a startup headline while the backend loads, then restores the default', async () => {
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

    progress.handle({ conversationId: 'c1', kind: 'phase', text: 'Forge: loading the model…' });
    await vi.advanceTimersByTimeAsync(999);
    await vi.advanceTimersByTimeAsync(1);
    expect(channel.edits).toEqual([
      {
        chatId: 'chat-a',
        messageId: 'message-1',
        text: 'Forge: loading the model…\n\n⏱ <1 min · 0 tool calls · last activity 1 s ago',
      },
    ]);

    progress.handle({ conversationId: 'c1', kind: 'phase', text: undefined });
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'On it.' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: 'Forge: working…\n\n⏱ <1 min · 0 tool calls · last activity 1 s ago',
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
  });

  it('cancels a pending update before writing the terminal state', async () => {
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
    progress.handle({ conversationId: 'c1', kind: 'status', text: 'late update' });

    await progress.finish('c1', 'Forge: completed.');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(channel.edits).toEqual([
      { chatId: 'chat-a', messageId: 'message-1', text: 'Forge: completed.' },
    ]);
  });

  it('latches warnings so a milestone does not overwrite them 1.5s later', async () => {
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

    const text = channel.edits.at(-1)!.text;
    expect(text).toContain('⚠ Forge: agent is repeating the same tool call');
    expect(text).toContain('Running read_file…');
  });

  it('replaces the milestone with an info notice but does not latch it', async () => {
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
    const channel = new FakeRemoteChannel();
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
    );
    progress.begin('c1', 'chat-a', 'message-1');

    for (let round = 0; round < 3; round += 1) {
      progress.handle({
        conversationId: 'c1',
        kind: 'notice',
        severity: 'warning',
        text: 'the same warning',
      });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    const occurrences = channel.edits.at(-1)!.text.split('the same warning').length - 1;
    expect(occurrences).toBe(1);
  });

  it('arms deletion of the finished progress bubble at the fixed queued-ack delay', async () => {
    vi.useFakeTimers();
    const channel = new FakeRemoteChannel();
    const armAfter = vi.fn();
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
      undefined,
      armAfter,
    );
    progress.begin('c1', 'chat-a', 'message-1');

    await progress.finish('c1', 'Forge: completed.');

    expect(armAfter).toHaveBeenCalledWith('chat-a', ['message-1'], 10);
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

  it('silently edits the clock once per interval and keeps the clock at the tail on truncation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const channel = new FakeRemoteChannel();
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
    progress.begin('c1', 'chat-a', 'message-1');
    await vi.advanceTimersByTimeAsync(30_000);
    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'run_build' });

    await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
    expect(channel.edits).toEqual([
      {
        chatId: 'chat-a',
        messageId: 'message-1',
        text: 'Forge: working…\n\nRunning run_build…\n\n⏱ 1 min · 1 tool call · last activity 30 s ago',
      },
    ]);
    expect(channel.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
    expect(channel.edits).toHaveLength(2);
    expect(channel.edits[1]?.text).toContain('⏱ 2 min · 1 tool call · last activity 1 min ago');
    expect(channel.sent).toEqual([]);

    const truncated = renderRemoteProgress(
      {
        headline: 'Forge: working…',
        warnings: [],
        milestone: 'Running '.concat('very_long_tool '.repeat(30)),
        startedAt: 0,
        lastActivityAt: 0,
        toolCalls: 2,
      },
      90,
      60_000,
    );
    expect(truncated.startsWith('Forge: working…\n\n')).toBe(true);
    expect(truncated).toContain('⏱ 1 min · 2 tool calls · last activity 1 min ago');
  });

  it('counts every tool and treats every non-terminal event, including reasoning, as activity only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const channel = new FakeRemoteChannel();
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      120_000,
      undefined,
      undefined,
      CLOCK_INTERVAL_MS,
    );
    progress.begin('c1', 'chat-a', 'message-1');
    const events = [
      { conversationId: 'c1', kind: 'tool', toolName: 'read_file' },
      { conversationId: 'c1', kind: 'commentary', text: 'hidden words' },
      { conversationId: 'c1', kind: 'narration', text: 'a finished thought' },
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
    await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);

    const bubble = channel.edits.at(-1)?.text ?? '';
    expect(bubble).toContain('2 tool calls');
    expect(bubble).toContain('last activity 1 min ago');
    expect(bubble).not.toContain('hidden words');
    expect(bubble).not.toContain('reasoning');
    expect(channel.sent).toEqual(['a finished thought'].map((text) => ({ chatId: 'chat-a', text })));
  });

  it('clears clock intervals on finish, dispose and replacement, and does not start one without edits', async () => {
    vi.useFakeTimers();
    const channel = new FakeRemoteChannel();
    const progress = new RemoteAgentProgress(
      channel,
      new AbortController().signal,
      () => true,
      3_900,
      1_000,
      undefined,
      undefined,
      1_000,
    );
    progress.begin('c1', 'chat-a', 'message-1');
    await progress.finish('c1', 'Forge: completed.');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channel.edits).toHaveLength(1);

    progress.begin('c2', 'chat-a', 'message-2');
    progress.begin('c2', 'chat-a', 'message-3');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits).toHaveLength(2);
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
