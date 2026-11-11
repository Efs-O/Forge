import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import { ToolLoopDetectedError, ToolLoopGuard } from '../../src/agent/ToolLoopGuard';
import {
  ALL_TOOL_PERMISSIONS,
  ToolRegistry,
  type RegisteredTool,
} from '../../src/tools/ToolRegistry';
import { isMutatingTool, READ_ONLY_PERMISSIONS } from '../../src/tools/toolContract';

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
    const repeated = result('same');
    expect(guard.afterRound(call('read_file', { path: 'a' }), repeated)).toBe(true);
    expect(repeated[0]?.content).toBe(
      '[Forge warning: this read-only tool call and result repeat round 1. ' +
        'Act on the result you already have or change approach.]\nsame',
    );
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
    ).toThrow('Forge: repeated tool call produced no progress.');
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
    expect(third[0]?.content).toBe(
      '[Forge warning: 3 failed read_file calls in a row on a. ' +
        'Read the error: it says what is wrong. Change the arguments or stop.]\nError: third',
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

  it('allows six identical mutating rounds with identical results', () => {
    const guard = new ToolLoopGuard();
    const calls = call('desktop_press', { keys: ['pagedown'] });
    for (let index = 0; index < 6; index++) {
      expect(() => guard.afterRound(calls, result('Pressed'), () => true)).not.toThrow();
    }
  });

  it('does not add the read-only repeat warning to a mutating repeat', () => {
    const guard = new ToolLoopGuard();
    const calls = call('desktop_press', { keys: ['pagedown'] });
    guard.afterRound(calls, result('Pressed'), () => true);
    const repeated = result('Pressed');
    expect(guard.afterRound(calls, repeated, () => true)).toBe(false);
    expect(repeated[0]?.content).toBe('Pressed');
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

describe('ToolRegistry loop-guard permission classes', () => {
  it.each(ALL_TOOL_PERMISSIONS)('%s is classified by its permission tier', (permission) => {
    const registry = new ToolRegistry();
    const tool: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: permission,
          description: '',
          parameters: { type: 'object', properties: {} },
        },
      },
      permission,
      ...(permission === 'write' || permission === 'delete'
        ? { mutation: { paths: () => [] } }
        : {}),
      handler: async () => '',
    };
    registry.register(tool);
    expect(isMutatingTool(registry.get(permission))).toBe(
      !READ_ONLY_PERMISSIONS.has(permission),
    );
  });

  it('treats additional mutating permissions as mutating and unknown names as read-only', () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        type: 'function',
        function: {
          name: 'read_with_write',
          description: '',
          parameters: { type: 'object', properties: {} },
        },
      },
      permission: 'read',
      additionalPermissions: ['write'],
      handler: async () => '',
    });
    expect(isMutatingTool(registry.get('read_with_write'))).toBe(true);
    expect(isMutatingTool(registry.get('unknown_tool'))).toBe(false);
  });
});
