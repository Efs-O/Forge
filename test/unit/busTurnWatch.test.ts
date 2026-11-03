import { describe, expect, it } from 'vitest';
import {
  BusTurnWatch,
  MAX_NARRATION_CHARS,
  MAX_WARNINGS,
  MAX_WATCHED,
  reduceTurn,
  type ProgressSource,
  type TurnSnapshot,
} from '../../src/agentBus/busTurnWatch';
import { renderBusStatus } from '../../src/agentBus/busStatusView';
import type { AgentProgressEvent } from '../../src/sidebar/AgentProgress';

const event = (kind: AgentProgressEvent['kind'], extra: Record<string, unknown> = {}): AgentProgressEvent =>
  ({ conversationId: 'c', kind, ...extra }) as AgentProgressEvent;

describe('reduceTurn', () => {
  it('folds tools, narration, warnings and end into an immutable snapshot', () => {
    const a = reduceTurn(undefined, event('tool', { toolName: 'read_file' }), 10);
    const b = reduceTurn(a, event('narration', { text: 'checking files' }), 20);
    const c = reduceTurn(b, event('tool', { toolName: 'write_file' }), 30);
    const d = reduceTurn(c, event('notice', { text: 'careful', severity: 'warning' }), 40);
    const ended = reduceTurn(d, event('end', { ok: true }), 50);
    expect(ended).toMatchObject({ state: 'ended', toolCalls: 2, lastTool: 'write_file', lastNarration: 'checking files', warnings: ['careful'], endedOk: true });
    expect(a).toMatchObject({ state: 'running', toolCalls: 1, lastEventAt: 10 });
  });

  it('starts a fresh turn after end', () => {
    const ended = reduceTurn(undefined, event('end', { ok: true }), 10);
    expect(reduceTurn(ended, event('status', { text: 'working' }), 20)).toMatchObject({ state: 'running', startedAt: 20, toolCalls: 0, warnings: [] });
  });

  it('never stores commentary text', () => {
    expect(JSON.stringify(reduceTurn(undefined, event('commentary', { text: 'SECRET' }), 10))).not.toContain('SECRET');
  });

  it('clips narration to one line and the configured cap', () => {
    const result = reduceTurn(undefined, event('narration', { text: `${'x'.repeat(600)}\nmore` }), 10);
    expect(result.lastNarration).toHaveLength(MAX_NARRATION_CHARS);
    expect(result.lastNarration).not.toContain('\n');
  });

  it('sets the phase and clears it on an undefined phase', () => {
    const set = reduceTurn(undefined, event('phase', { text: 'Thinking' }), 10);
    expect(set.phase).toBe('Thinking');
    expect(reduceTurn(set, event('phase', {}), 20)).not.toHaveProperty('phase');
  });

  it('records an info notice only as activity', () => {
    const before = reduceTurn(undefined, event('tool', { toolName: 'read_file' }), 10);
    const after = reduceTurn(before, event('notice', { text: 'fyi', severity: 'info' }), 20);
    expect(after).toEqual({ ...before, lastEventAt: 20 });
  });

  it('records reasoning as liveness without retaining reasoning text', () => {
    const before = reduceTurn(undefined, event('tool', { toolName: 'read_file' }), 10);
    const after = reduceTurn(before, event('reasoning', { text: 'SECRET reasoning' }), 20);
    expect(after).toEqual({ ...before, lastEventAt: 20 });
    expect(JSON.stringify(after)).not.toContain('SECRET');
  });

  it('keeps the previous narration when the new one is blank', () => {
    const said = reduceTurn(undefined, event('narration', { text: 'reading the plan' }), 10);
    expect(reduceTurn(said, event('narration', { text: ' \n\t ' }), 20).lastNarration).toBe('reading the plan');
  });

  it('keeps only the latest four warnings in order', () => {
    let result = reduceTurn(undefined, event('status', { text: 'start' }), 0);
    for (let i = 0; i < 6; i++) result = reduceTurn(result, event('notice', { text: `warning ${i}`, severity: 'warning' }), i + 1);
    expect(MAX_WARNINGS).toBe(4);
    expect(result.warnings).toEqual(['warning 2', 'warning 3', 'warning 4', 'warning 5']);
  });
});

describe('turn timing (audit F4)', () => {
  const conversation = { id: 'c', title: 'Marker chat', activeModel: 'alpha' };
  /** The whole `forge.sh status` body for one snapshot, at one instant. */
  const statusOf = (turn: TurnSnapshot | undefined, now: number): string =>
    renderBusStatus({
      conversation,
      streaming: turn?.state === 'running',
      queuedFromSender: 0,
      budget: undefined,
      turn,
      watchAttached: true,
      now,
    });

  it('times a model-only turn that named no tool and said nothing', () => {
    // The audit's 16.075 s marker request: Forge's own stream log said 16 s
    // while `status` said `after 0 s`. A turn like this emits exactly one
    // progress event, the closing one, and the snapshot was built from that
    // event alone - so its start and its end were the same instant.
    const started = reduceTurn(undefined, event('start'), 1_000);
    const ended = reduceTurn(started, event('end', { ok: true }), 17_000);
    expect(ended).toMatchObject({
      state: 'ended',
      startedAt: 1_000,
      endedAt: 17_000,
      toolCalls: 0,
    });
    expect(statusOf(ended, 17_000)).toContain(
      'idle · last turn ended ok 0 s ago after 16 s, 0 tool call(s)',
    );
  });

  it('measures a stopped turn from its own start, not the previous turn', () => {
    // The audit's 2.175 s stopped request reported `after 31 s`: the closing
    // event landed on the snapshot the PREVIOUS turn had left behind, so the
    // duration ran from that turn's start to this turn's end.
    const first = reduceTurn(
      reduceTurn(undefined, event('start'), 0),
      event('end', { ok: true }),
      31_000,
    );
    const stopped = reduceTurn(first, event('start'), 40_000);
    expect(stopped).toMatchObject({ state: 'running', startedAt: 40_000, toolCalls: 0 });
    const ended = reduceTurn(stopped, event('end', { ok: false }), 42_175);
    expect(statusOf(ended, 42_175)).toContain(
      'idle · last turn ended with an error 0 s ago after 2 s, 0 tool call(s)',
    );
  });

  it('resets the turn at its start, not at the first event of the next one', () => {
    const busy = reduceTurn(
      reduceTurn(undefined, event('start'), 0),
      event('tool', { toolName: 'shell' }),
      5,
    );
    expect(busy.toolCalls).toBe(1);
    const next = reduceTurn(busy, event('start'), 10);
    expect(next).toMatchObject({
      state: 'running',
      startedAt: 10,
      lastEventAt: 10,
      toolCalls: 0,
      warnings: [],
    });
  });

  it('has a running snapshot for a turn that has not emitted anything yet', () => {
    // A model-only turn in flight emits nothing until it ends, so the watch had
    // nothing for the chat and `status` printed `this turn started before the
    // watcher attached` for a turn that started after it.
    let listener: ((event: AgentProgressEvent) => void) | undefined;
    const watch = new BusTurnWatch(() => 12_000);
    watch.attach({
      onAgentProgress: (next) => {
        listener = next;
        return { dispose: () => undefined };
      },
    });
    listener?.(event('start'));
    const snapshot = watch.snapshot('c');
    expect(snapshot).toMatchObject({ state: 'running', startedAt: 12_000 });
    const status = statusOf(snapshot, 17_000);
    expect(status).toContain('busy · turn running 5 s · last activity 5 s ago');
    expect(status).not.toContain('started before the watcher attached');
  });
});

describe('BusTurnWatch', () => {
  it('attaches once, retries a missing stream, evicts the oldest and disposes', () => {
    let listener: ((event: AgentProgressEvent) => void) | undefined;
    let subscriptions = 0;
    let disposed = 0;
    const watch = new BusTurnWatch(() => 1);
    expect(watch.attached).toBe(false);
    expect(watch.attach({})).toBe(false);
    const source: ProgressSource = {
      onAgentProgress: (next) => {
        subscriptions++;
        listener = next;
        return { dispose: () => disposed++ };
      },
    };
    expect(watch.attach(source)).toBe(true);
    expect(watch.attach(source)).toBe(true);
    expect(subscriptions).toBe(1);
    for (let i = 0; i < MAX_WATCHED + 1; i++) listener?.({ conversationId: `c${i}`, kind: 'status', text: 'working' });
    expect(watch.snapshot('c0')).toBeUndefined();
    expect(watch.snapshot(`c${MAX_WATCHED}`)).toBeDefined();
    watch.dispose();
    expect(disposed).toBe(1);
    expect(watch.snapshot(`c${MAX_WATCHED}`)).toBeUndefined();
  });
});
