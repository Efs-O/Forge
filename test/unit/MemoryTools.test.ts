import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  listMemoryKeys,
  makeForgetTool,
  makeListMemoriesTool,
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
    await remember.handler({ key: 'one', value: 'old', description: 'old desc' });
    await remember.handler({ key: 'one', value: 'new', description: 'new desc' });
    await remember.handler({ key: 'two', value: 'kept', description: 'kept desc' });
    expect(listMemoryKeys(m.state)).toEqual(['one', 'two']);
    expect(await recall.handler({ key: 'one' })).toBe('new');
    expect(await forget.handler({ key: 'one' })).toBe('Forgot "one".');
    expect(await forget.handler({ key: 'one' })).toBe('Memory "one" was already absent.');
    expect(listMemoryKeys(m.state)).toEqual(['two']);
    expect(await makeListMemoriesTool(m.state).handler({})).toBe('- two: kept desc');
    expect(await recall.handler({ key: 'one' })).toBe('(not found)');
    expect(forgot).toHaveBeenCalledWith('one');
  });

  it('serializes concurrent remembers so the index keeps both keys', async () => {
    const m = memory();
    const remember = makeRememberTool(m.state);
    await Promise.all([
      remember.handler({ key: 'alpha', value: 'a', description: 'alpha desc' }),
      remember.handler({ key: 'beta', value: 'b', description: 'beta desc' }),
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
    await expect(remember.handler({ key: 'alpha', value: 'a', description: 'desc' })).rejects.toThrow('storage failed');
    expect(m.data.get('forge.memory.__keys__')).toEqual(['alpha']);
    expect(listMemoryKeys(m.state)).toEqual([]);
    await remember.handler({ key: 'alpha', value: 'a', description: 'desc' });
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
    expect(() => registry.assertAllowed(forget, new Set(['read']))).toThrow(
      'is not available in this conversation',
    );
    expect(() => registry.assertAllowed(forget, new Set(['delete']))).not.toThrow();
    expect(forget.mutation).toBeUndefined();
  });

  it('keeps the memory deletion detail without marking it as a Clanker stop', () => {
    const forget = makeForgetTool(memory().state);
    const metadata = forget.approval?.({ key: 'old-note' });
    expect(metadata?.detail).toBe('Remove stored workspace memory "old-note"?');
    expect(metadata?.clankerStop).toBeUndefined();
  });

  it('stores trimmed descriptions and lists described and legacy memories oldest first', async () => {
    const key = 'legacy';
    const m = memory({
      'forge.memory.__keys__': [key],
      [`forge.memory.${key}`]: 'old value',
    });
    const remember = makeRememberTool(m.state);
    await remember.handler({ key: 'new', value: 'value', description: '  short note  ' });
    expect(await makeListMemoriesTool(m.state).handler({})).toBe('- legacy\n- new: short note');
    await remember.handler({ key: 'new', value: 'updated', description: 'replacement' });
    expect(await makeListMemoriesTool(m.state).handler({})).toBe('- legacy\n- new: replacement');
  });

  it('remembers without a description and lists only its key', async () => {
    const m = memory();
    const remember = makeRememberTool(m.state);
    expect(await remember.handler({ key: 'k', value: 'saved' })).toBe(
      'Remembered. Without a description, new chats list only the key; call remember again with a description to add one.',
    );
    expect(await makeListMemoriesTool(m.state).handler({})).toBe('- k');
  });

  it('shows only the first line of a two-line description', async () => {
    const m = memory();
    await makeRememberTool(m.state).handler({
      key: 'k',
      value: 'saved',
      description: 'first line\nsecond line',
    });
    expect(await makeListMemoriesTool(m.state).handler({})).toBe('- k: first line');
  });

  it('clips a long description in the index while keeping the stored value intact', async () => {
    const m = memory();
    const description = 'x'.repeat(250);
    await makeRememberTool(m.state).handler({ key: 'k', value: 'saved', description });
    expect(await makeListMemoriesTool(m.state).handler({})).toBe(`- k: ${'x'.repeat(200)}…`);
    expect(m.data.get('forge.memory.__descriptions__')).toEqual({ k: description });
  });

  it('removes an old description when a blank one replaces it', async () => {
    const m = memory();
    const remember = makeRememberTool(m.state);
    await remember.handler({ key: 'k', value: 'old', description: 'old description' });
    expect(await remember.handler({ key: 'k', value: 'new', description: '   ' })).toBe(
      'Remembered. Without a description, new chats list only the key; call remember again with a description to add one.',
    );
    expect(await makeListMemoriesTool(m.state).handler({})).toBe('- k');
  });

  it('removes descriptions when forgetting and refuses the descriptions index as a key', async () => {
    const m = memory();
    const remember = makeRememberTool(m.state);
    await remember.handler({ key: 'note', value: 'v', description: 'first' });
    await makeForgetTool(m.state).handler({ key: 'note' });
    await remember.handler({ key: 'note', value: 'v2', description: 'second' });
    expect(await makeListMemoriesTool(m.state).handler({})).toBe('- note: second');
    await expect(
      remember.handler({ key: '__descriptions__', value: 'v', description: 'd' }),
    ).rejects.toThrow('__keys__ or __descriptions__');
  });

  it('publishes the exact schema description and tool description', () => {
    const remember = makeRememberTool(memory().state);
    const fn = remember.definition.function;
    expect(fn.description).toBe(
      'Store a decision or pending state that must survive context compaction or help a later chat. Use it for anything not already in FORGE.md or the files that you would have to re-derive. Every new chat in this workspace starts with the stored keys and their descriptions, and the keys are listed back to you after every compaction. Overwrites an existing key and its description.',
    );
    expect(fn.parameters.properties.description.description).toBe(
      'One line saying what this memory holds. Every new chat in this workspace starts with the list of keys and these descriptions.',
    );
    expect(fn.parameters.required).toEqual(['key', 'value']);
    expect(fn.parameters.additionalProperties).toBe(false);
  });
});
