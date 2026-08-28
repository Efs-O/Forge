import { describe, expect, it } from 'vitest';
import { supersedeStaleReads } from '../../src/agent/staleReadSupersede';
import type { ChatMessage } from '../../src/llm/types';

function read(id: string, path: string): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } },
    ],
  };
}

function result(id: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, name: 'read_file', content };
}

describe('supersedeStaleReads', () => {
  it('elides an earlier read once the same path is read again', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Fix the bug.' },
      read('a', 'src/app.ts'),
      result('a', 'export const version = 1;'),
      read('b', 'src/app.ts'),
      result('b', 'export const version = 2;'),
    ];

    const out = supersedeStaleReads(messages);

    expect(out[2]?.content).toContain('superseded');
    expect(out[2]?.content).toContain('src/app.ts');
    expect(out[4]?.content).toBe('export const version = 2;');
  });

  it('leaves a single read untouched', () => {
    const messages: ChatMessage[] = [read('a', 'src/app.ts'), result('a', 'contents')];
    expect(supersedeStaleReads(messages)).toBe(messages);
  });

  it('keeps a stale read that was never re-read, even after an edit', () => {
    // The whole safety rule: without a later copy, eliding destroys the only
    // version of the file the model has.
    const messages: ChatMessage[] = [
      read('a', 'src/app.ts'),
      result('a', 'export const version = 1;'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'e',
            type: 'function',
            function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/app.ts' }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'e', name: 'edit_file', content: 'ok' },
    ];
    expect(supersedeStaleReads(messages)).toBe(messages);
  });

  it('treats different paths independently', () => {
    const messages: ChatMessage[] = [
      read('a', 'src/a.ts'),
      result('a', 'A1'),
      read('b', 'src/b.ts'),
      result('b', 'B1'),
      read('c', 'src/a.ts'),
      result('c', 'A2'),
    ];

    const out = supersedeStaleReads(messages);

    expect(out[1]?.content).toContain('superseded');
    expect(out[3]?.content).toBe('B1');
    expect(out[5]?.content).toBe('A2');
  });

  it('normalizes separators so one file is not treated as two', () => {
    const messages: ChatMessage[] = [
      read('a', 'src\\app.ts'),
      result('a', 'old'),
      read('b', 'src/app.ts'),
      result('b', 'new'),
    ];
    expect(supersedeStaleReads(messages)[1]?.content).toContain('superseded');
  });

  it('never elides or trusts an errored or truncated result', () => {
    const messages: ChatMessage[] = [
      read('a', 'src/app.ts'),
      result('a', 'export const version = 1;'),
      read('b', 'src/app.ts'),
      result('b', 'Error: ENOENT'),
      read('c', 'src/app.ts'),
      result('c', 'partial\n\n[truncated by read_file — showing 10 of 99 chars]'),
    ];

    const out = supersedeStaleReads(messages);

    // 'a' is the last COMPLETE read, so it stays; the incomplete ones stay too.
    expect(out[1]?.content).toBe('export const version = 1;');
    expect(out[3]?.content).toBe('Error: ENOENT');
    expect(out[5]?.content).toContain('[truncated by');
  });

  it('ignores calls whose arguments do not parse', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
        ],
      },
      result('a', 'contents'),
      read('b', 'src/app.ts'),
      result('b', 'other'),
    ];
    expect(supersedeStaleReads(messages)[1]?.content).toBe('contents');
  });

  it('does not mutate the input array or its messages', () => {
    const original = result('a', 'export const version = 1;');
    const messages: ChatMessage[] = [
      read('a', 'src/app.ts'),
      original,
      read('b', 'src/app.ts'),
      result('b', 'export const version = 2;'),
    ];

    const out = supersedeStaleReads(messages);

    expect(out).not.toBe(messages);
    expect(original.content).toBe('export const version = 1;');
  });
});
