import { describe, expect, it } from 'vitest';
import {
  renderBusStatus,
  renderBusView,
  renderQueuedStatus,
} from '../../src/agentBus/busStatusView';
import { describeBudget } from '../../src/remote/RemoteSessionCommands';
import type { TurnSnapshot } from '../../src/agentBus/busTurnWatch';
import type { ForgeExchange } from '../../src/sidebar/sessionProjections';

const base = (extra: Partial<Parameters<typeof renderBusStatus>[0]> = {}) => ({
  conversation: { id: 'c1', title: 'Chat', activeModel: 'Qwen', requestCount: 2, toolCallCount: 3 },
  streaming: false,
  queuedFromSender: 0,
  budget: { used: 59_000, max: 100_000 },
  turn: undefined,
  watchAttached: true,
  now: 1_000_000,
  ...extra,
});
const turn = (extra: Partial<TurnSnapshot> = {}): TurnSnapshot => ({
  state: 'running', startedAt: 900_000, lastEventAt: 950_000, toolCalls: 2, warnings: [], ...extra,
});

describe('renderBusStatus', () => {
  it('renders an idle chat with no turn in six lines', () => {
    expect(renderBusStatus(base())).toBe(
      'Chat: Chat · c1\n' +
        'State: idle\n' +
        'Model: Qwen\n' +
        'Context: 59000/100000 tokens (59%)\n' +
        'Queued from you: 0\n' +
        'Work: 2 model request(s), 3 tool call(s), 0 compaction(s) in this chat',
    );
  });

  it('names an owner-only approval after Now', () => {
    expect(
      renderBusStatus(
        base({
          streaming: true,
          turn: turn({ lastTool: 'rm_file' }),
          waiting: { kind: 'approval', toolName: 'rm_file', ownerOnly: true },
        }),
      ),
    ).toBe(
      'Chat: Chat · c1\n' +
        'State: busy · turn running 1 min · last activity 50 s ago\n' +
        'Model: Qwen\n' +
        'Now: working · last tool rm_file · 2 tool call(s) this turn\n' +
        'Waiting: an approval card for rm_file is open in this chat; only the owner can answer it\n' +
        'Context: 59000/100000 tokens (59%)\n' +
        'Queued from you: 0\n' +
        'Work: 2 model request(s), 3 tool call(s), 0 compaction(s) in this chat',
    );
  });

  it('names an approval after Now', () => {
    expect(
      renderBusStatus(
        base({
          streaming: true,
          turn: turn({ lastTool: 'write_file' }),
          waiting: { kind: 'approval', toolName: 'write_file', ownerOnly: false },
        }),
      ),
    ).toBe(
      'Chat: Chat · c1\n' +
        'State: busy · turn running 1 min · last activity 50 s ago\n' +
        'Model: Qwen\n' +
        'Now: working · last tool write_file · 2 tool call(s) this turn\n' +
        'Waiting: an approval card for write_file is open in this chat\n' +
        'Context: 59000/100000 tokens (59%)\n' +
        'Queued from you: 0\n' +
        'Work: 2 model request(s), 3 tool call(s), 0 compaction(s) in this chat',
    );
  });

  it('names a question after Model when no Now line is present', () => {
    expect(renderBusStatus(base({ waiting: { kind: 'question' } }))).toBe(
      'Chat: Chat · c1\n' +
        'State: idle\n' +
        'Model: Qwen\n' +
        'Waiting: a question (ask_user) is open in this chat\n' +
        'Context: 59000/100000 tokens (59%)\n' +
        'Queued from you: 0\n' +
        'Work: 2 model request(s), 3 tool call(s), 0 compaction(s) in this chat',
    );
  });

  it('reports the compaction count on the Work line', () => {
    expect(
      renderBusStatus(
        base({
          conversation: {
            id: 'c1',
            title: 'Chat',
            activeModel: 'Qwen',
            requestCount: 2,
            toolCallCount: 3,
            compactCount: 2,
          },
        }),
      ),
    ).toContain('Work: 2 model request(s), 3 tool call(s), 2 compaction(s) in this chat');
  });

  it('adds the status bar active time under the Work line when known', () => {
    const output = renderBusStatus(
      base({ conversation: { id: 'c1', title: 'Chat', activeMs: 23_080_000 } }),
    );
    expect(output.split('\n').at(-1)).toBe(
      'Active time: 6 h 24 min (model work and tools, approval waits excluded)',
    );
  });

  it('reports a running turn and its latest details', () => {
    const output = renderBusStatus(base({ streaming: true, turn: turn({ lastTool: 'read_file', lastNarration: 'I read it', phase: 'checking' }) }));
    expect(output).toContain('State: busy · turn running 1 min · last activity 50 s ago');
    expect(output).toContain('Now: checking · last tool read_file · 2 tool call(s) this turn');
    expect(output).toContain('Said: I read it');
  });

  it('reports unavailable detail when streaming and the watcher is unattached', () => {
    expect(renderBusStatus(base({ streaming: true, watchAttached: false }))).toContain('State: busy · live detail unavailable (the watcher is not attached yet)');
  });

  it('reports a pre-attach streaming turn when no snapshot exists', () => {
    expect(renderBusStatus(base({ streaming: true, turn: undefined }))).toContain('State: busy · this turn started before the watcher attached; no live detail');
  });

  it('reports the last ended turn and rounded-down durations', () => {
    const ended = turn({ state: 'ended', startedAt: 1_000_000 - 125 * 60_000, endedAt: 1_000_000 - 59_000, endedOk: false });
    expect(renderBusStatus(base({ turn: ended }))).toContain('State: idle · last turn ended with an error 59 s ago after 2 h 4 min, 2 tool call(s)');
  });

  it.each([
    [59, '59 s'], [60, '1 min'], [59 * 60, '59 min'], [60 * 60, '1 h 0 min'], [125 * 60, '2 h 5 min'],
  ])('formats duration boundary %i seconds as %s', (seconds, expected) => {
    const ended = turn({ state: 'ended', startedAt: 0, endedAt: 0, endedOk: true });
    expect(renderBusStatus(base({ turn: ended, now: seconds * 1_000 }))).toContain(`ended ok ${expected} ago`);
  });

  it('reuses the canonical context budget formatter', () => {
    const budget = { used: 4, max: 10 };
    expect(renderBusStatus(base({ budget }))).toContain(`Context: ${describeBudget(budget)}`);
    expect(renderBusStatus(base({ budget: undefined }))).toContain(`Context: ${describeBudget(undefined)}`);
  });
});

describe('renderBusView', () => {
  const exchanges: ForgeExchange[] = [
    { prompt: 'first prompt', answer: 'first answer' },
    { prompt: 'second prompt', answer: 'second answer' },
  ];

  it('renders an empty view and appends the running note when needed', () => {
    expect(renderBusView([], { clamped: false, streaming: false })).toBe('No answers in this chat yet.');
    expect(renderBusView([], { clamped: false, streaming: true })).toBe('Note: a turn is running; the last entry may be partial.\n\nNo answers in this chat yet.');
  });

  it('prepends clamped and streaming notes', () => {
    expect(renderBusView([], { clamped: true, streaming: true })).toBe('Note: showing the last 10, the maximum.\nNote: a turn is running; the last entry may be partial.\n\nNo answers in this chat yet.');
  });

  it('renders exchanges oldest first using the canonical exchange renderer', () => {
    const output = renderBusView(exchanges, { clamped: false, streaming: false });
    expect(output.indexOf('[1/2]')).toBeLessThan(output.indexOf('[2/2]'));
    expect(output.match(/\n\n---\n\n/g)).toHaveLength(1);
    expect(output).toContain('first answer');
    expect(output).toContain('second answer');
  });
});

describe('renderQueuedStatus', () => {
  it('answers with the lines forge.sh wait reads, and no chat it cannot show yet', () => {
    // Audit F3: `say --new` answers 202 and says the message is queued, but no
    // chat exists until it runs, so `status` answered 404 and `wait` treated
    // that as a dead endpoint and exited 1 on the queue it was told to watch.
    expect(renderQueuedStatus(2).split('\n')).toEqual([
      'Chat: none yet — your message is accepted and has not started',
      'State: queued',
      'Queued from you: 2',
    ]);
  });

  it('does not claim idle while a message is still queued', () => {
    // `wait` exits on `State: idle` with `Queued from you: 0`; a queued message
    // must not read as an idle chat with nothing in it.
    expect(renderQueuedStatus(1)).not.toContain('State: idle');
  });
});
