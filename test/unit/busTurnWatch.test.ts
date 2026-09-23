import { describe, expect, it } from 'vitest';
import {
  BusTurnWatch,
  MAX_NARRATION_CHARS,
  MAX_WARNINGS,
  MAX_WATCHED,
  reduceTurn,
  type ProgressSource,
} from '../../src/agentBus/busTurnWatch';
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

  it('keeps only the latest four warnings in order', () => {
    let result = reduceTurn(undefined, event('status', { text: 'start' }), 0);
    for (let i = 0; i < 6; i++) result = reduceTurn(result, event('notice', { text: `warning ${i}`, severity: 'warning' }), i + 1);
    expect(MAX_WARNINGS).toBe(4);
    expect(result.warnings).toEqual(['warning 2', 'warning 3', 'warning 4', 'warning 5']);
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
