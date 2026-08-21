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
