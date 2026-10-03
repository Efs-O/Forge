import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  listMemoryKeys,
  makeForgetTool,
  makeRecallTool,
  makeRememberTool,
} from '../../src/tools/memoryTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

function memory(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  let calls = 0;
  let failAt = -1;
  const state = {
    get: <T>(key: string): T | undefined => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      calls += 1;
      if (calls === failAt) throw new Error('storage failed');
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
  } as vscode.Memento;
  return {
    state,
    data,
    failNext: (offset = 1) => {
      failAt = calls + offset;
    },
  };
}

describe('workspace memory lifecycle', () => {
  it('remembers, overwrites, and forgets one key without touching another', async () => {
    const m = memory();
    const remember = makeRememberTool(m.state);
    const recall = makeRecallTool(m.state);
    const forgot = vi.fn();
    const forget = makeForgetTool(m.state, forgot);
    await remember.handler({ key: 'one', value: 'old' });
    await remember.handler({ key: 'one', value: 'new' });
    await remember.handler({ key: 'two', value: 'kept' });
    expect(listMemoryKeys(m.state)).toEqual(['one', 'two']);
    expect(await recall.handler({ key: 'one' })).toBe('new');
    expect(await forget.handler({ key: 'one' })).toBe('Forgot "one".');
    expect(await forget.handler({ key: 'one' })).toBe('Memory "one" was already absent.');
    expect(listMemoryKeys(m.state)).toEqual(['two']);
    expect(await recall.handler({ key: 'one' })).toBe('(not found)');
    expect(forgot).toHaveBeenCalledWith('one');
  });

  it('serializes concurrent remembers so the index keeps both keys', async () => {
    const m = memory();
    const remember = makeRememberTool(m.state);
    await Promise.all([
      remember.handler({ key: 'alpha', value: 'a' }),
      remember.handler({ key: 'beta', value: 'b' }),
    ]);
    expect(listMemoryKeys(m.state)).toEqual(['alpha', 'beta']);
  });

  it('reads and removes an older indexed key outside the new-key character set', async () => {
    const key = 'old task / follow-up';
    const m = memory({ 'forge.memory.__keys__': [key], [`forge.memory.${key}`]: 'saved' });
    expect(await makeRecallTool(m.state).handler({ key })).toBe('saved');
    expect(await makeForgetTool(m.state).handler({ key })).toBe(`Forgot "${key}".`);
    expect(listMemoryKeys(m.state)).toEqual([]);
  });

  it('filters an index entry left by a failed new value write, then recovers on retry', async () => {
    const m = memory();
    const remember = makeRememberTool(m.state);
    m.failNext(2);
    await expect(remember.handler({ key: 'alpha', value: 'a' })).rejects.toThrow('storage failed');
    expect(m.data.get('forge.memory.__keys__')).toEqual(['alpha']);
    expect(listMemoryKeys(m.state)).toEqual([]);
    await remember.handler({ key: 'alpha', value: 'a' });
    expect(listMemoryKeys(m.state)).toEqual(['alpha']);
  });

  it('preserves a value on failed deletion and hides a stale index after the second write fails', async () => {
    const m = memory({ 'forge.memory.__keys__': ['alpha'], 'forge.memory.alpha': 'a' });
    const forgot = vi.fn();
    const forget = makeForgetTool(m.state, forgot);
    m.failNext();
    await expect(forget.handler({ key: 'alpha' })).rejects.toThrow('storage failed');
    expect(listMemoryKeys(m.state)).toEqual(['alpha']);
    expect(forgot).not.toHaveBeenCalled();
    m.failNext(2);
    await expect(forget.handler({ key: 'alpha' })).rejects.toThrow('storage failed');
    expect(listMemoryKeys(m.state)).toEqual([]);
    expect(forgot).toHaveBeenCalledWith('alpha');
    await forget.handler({ key: 'alpha' });
    expect(m.data.has('forge.memory.__keys__')).toBe(true);
    expect(listMemoryKeys(m.state)).toEqual([]);
  });

  it('requires delete permission without inventing a file mutation path', () => {
    const m = memory();
    const registry = new ToolRegistry();
    const forget = makeForgetTool(m.state);
    registry.register(forget);
    expect(() => registry.assertAllowed(forget, new Set(['read']))).toThrow(/delete/u);
    expect(() => registry.assertAllowed(forget, new Set(['delete']))).not.toThrow();
    expect(forget.mutation).toBeUndefined();
  });
});
