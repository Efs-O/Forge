import { describe, expect, it } from 'vitest';
import { renderBusStatus, renderBusView } from '../../src/agentBus/busStatusView';
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
    expect(renderBusStatus(base()).split('\n')).toEqual([
      'Chat: Chat · c1', 'State: idle', 'Model: Qwen', 'Context: 59000/100000 tokens (59%)',
      'Queued from you: 0', 'Work: 2 model request(s), 3 tool call(s) in this chat',
    ]);
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
