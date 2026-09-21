import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import { ToolLoopDetectedError, ToolLoopGuard } from '../../src/agent/ToolLoopGuard';

function call(name: string, args: Record<string, unknown>): ToolCall[] {
  return [
    {
      id: 'call',
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ];
}

function result(content: string): ChatMessage[] {
  return [{ role: 'tool', name: 'tool', tool_call_id: 'call', content }];
}

describe('ToolLoopGuard', () => {
  it('warns on the first exact read-only repeat without throwing', () => {
    const guard = new ToolLoopGuard();
    expect(guard.afterRound(call('read_file', { path: 'a' }), result('same'))).toBe(false);
    expect(guard.afterRound(call('read_file', { path: 'a' }), result('same'))).toBe(true);
  });

  it('warns when a repeat matches an earlier non-adjacent round', () => {
    const guard = new ToolLoopGuard();
    const a = call('read_file', { path: 'a' });
    const b = call('read_file', { path: 'b' });
    guard.afterRound(a, result('A'));
    guard.afterRound(b, result('B'));
    expect(guard.afterRound(a, result('A'))).toBe(true);
  });

  it('normalizes JSON key order and stops six identical read-only no-progress results', () => {
    const guard = new ToolLoopGuard();
    for (let index = 0; index < 5; index++) {
      guard.afterRound(call('read_file', { line: 1, path: 'a' }), result('same'));
    }
    expect(() =>
      guard.afterRound(call('read_file', { path: 'a', line: 1 }), result('same')),
    ).toThrow(ToolLoopDetectedError);
  });

  it('allows repeated polling when the result changes', () => {
    const guard = new ToolLoopGuard();
    guard.afterRound(call('get_status', {}), result('loading'));
    guard.afterRound(call('get_status', {}), result('still loading'));
    expect(() => guard.afterRound(call('get_status', {}), result('ready'))).not.toThrow();
  });

  it('does not warn when the repeated call has a different result', () => {
    const guard = new ToolLoopGuard();
    const calls = call('get_status', {});
    guard.afterRound(calls, result('first'));
    expect(guard.afterRound(calls, result('second'))).toBe(false);
  });

  it('warns on the third consecutive failed call for the same tool and path', () => {
    const guard = new ToolLoopGuard();
    const calls = call('read_file', { path: 'a' });
    expect(guard.afterRound(calls, result('Error: first'))).toBe(false);
    expect(guard.afterRound(calls, result('Error: second'))).toBe(false);
    const third = result('Error: third');
    expect(guard.afterRound(calls, third)).toBe(true);
    expect(third[0]?.content).toContain(
      '[Forge warning: 3 failed read_file calls in a row on a. Read the error: it says what is wrong. Change the arguments or stop.]',
    );
  });

  it('does not warn after only two failures, and a success resets the streak', () => {
    const guard = new ToolLoopGuard();
    const calls = call('read_file', { path: 'a' });
    guard.afterRound(calls, result('Error: first'));
    guard.afterRound(calls, result('Error: second'));
    expect(guard.afterRound(calls, result('contents'))).toBe(false);
    guard.afterRound(calls, result('Error: after reset'));
    guard.afterRound(calls, result('Error: after reset again'));
    expect(guard.afterRound(calls, result('Error: third after reset'))).toBe(true);
  });

  it('still throws when the identical failing call repeats', () => {
    const guard = new ToolLoopGuard();
    const calls = call('read_file', { path: 'a', start_line: 900 });
    expect(() => {
      for (let i = 0; i < 6; i++) guard.afterRound(calls, result('Error: past end'));
    }).toThrow(ToolLoopDetectedError);
  });

  it('does not combine failed calls for different paths', () => {
    const guard = new ToolLoopGuard();
    guard.afterRound(call('read_file', { path: 'a' }), result('Error: a1'));
    guard.afterRound(call('read_file', { path: 'b' }), result('Error: b1'));
    const pathA = result('Error: a2');
    expect(guard.afterRound(call('read_file', { path: 'a' }), pathA)).toBe(false);
    expect(pathA[0]?.content).toBe('Error: a2');
  });

  it('blocks a repeated mutation before its third execution', () => {
    const guard = new ToolLoopGuard();
    const calls = call('write_file', { path: 'a', content: 'x' });
    guard.afterRound(calls, result('written'));
    guard.afterRound(calls, result('written'));
    expect(() => guard.beforeRound(calls, () => true)).toThrow(/before a third execution/);
  });

  it('detects a repeated alternating cycle', () => {
    const guard = new ToolLoopGuard();
    const a = call('read_file', { path: 'a' });
    const b = call('read_file', { path: 'b' });
    for (let index = 0; index < 9; index++) {
      guard.afterRound(index % 2 === 0 ? a : b, result(index % 2 === 0 ? 'A' : 'B'));
    }
    expect(() => guard.afterRound(b, result('B'))).toThrow(/alternating/);
  });
});
