import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
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

  it('coalesces visible commentary and a safe tool milestone into one edit', async () => {
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
        text:
          'Forge: working…\n\nI read the file. Now I will update it.\n\nRunning read_file…',
      },
    ]);

    progress.handle({ conversationId: 'c1', kind: 'tool', toolName: 'read_file' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits).toHaveLength(1);
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
      { chatId: 'chat-a', messageId: 'message-1', text: 'Forge: loading the model…' },
    ]);

    progress.handle({ conversationId: 'c1', kind: 'phase', text: undefined });
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'On it.' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.edits.at(-1)).toEqual({
      chatId: 'chat-a',
      messageId: 'message-1',
      text: 'Forge: working…\n\nOn it.',
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
    progress.handle({ conversationId: 'remote', kind: 'commentary', text: 'private update' });
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
    progress.handle({ conversationId: 'c1', kind: 'commentary', text: 'late update' });

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

});
