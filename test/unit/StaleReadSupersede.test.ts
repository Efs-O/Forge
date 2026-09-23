import { describe, expect, it } from 'vitest';
import { annotateRereads } from '../../src/agent/staleReadSupersede';
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

describe('annotateRereads', () => {
  it('appends a note to the later read, leaving the earlier copy byte-identical', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Fix the bug.' },
      read('a', 'src/app.ts'),
      result('a', 'export const version = 1;'),
      read('b', 'src/app.ts'),
      result('b', 'export const version = 2;'),
    ];

    const out = annotateRereads(messages);

    // The earlier copy is untouched.
    expect(out[2]?.content).toBe('export const version = 1;');
    // The later copy carries the note.
    expect(out[4]?.content).toContain('export const version = 2;');
    expect(out[4]?.content).toContain('[Forge: this replaces your earlier read of src/app.ts.');
    expect(out[4]?.content).toContain('That earlier copy is stale; use this one.');
  });

  it('leaves a single read untouched', () => {
    const messages: ChatMessage[] = [read('a', 'src/app.ts'), result('a', 'contents')];
    expect(annotateRereads(messages)).toBe(messages);
  });

  it('keeps a stale read that was never re-read, even after an edit', () => {
    // The whole safety rule: without a later copy, there is nothing to annotate.
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
    expect(annotateRereads(messages)).toBe(messages);
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

    const out = annotateRereads(messages);

    // 'a' is untouched; 'b' is untouched; 'c' (re-read of a.ts) gets the note.
    expect(out[1]?.content).toBe('A1');
    expect(out[3]?.content).toBe('B1');
    expect(out[5]?.content).toContain('A2');
    expect(out[5]?.content).toContain('[Forge: this replaces your earlier read of src/a.ts.');
  });

  it('normalizes separators so one file is not treated as two', () => {
    const messages: ChatMessage[] = [
      read('a', 'src\\app.ts'),
      result('a', 'old'),
      read('b', 'src/app.ts'),
      result('b', 'new'),
    ];
    const out = annotateRereads(messages);
    // The earlier copy is untouched.
    expect(out[1]?.content).toBe('old');
    // The later copy gets the note with the normalized path.
    expect(out[3]?.content).toContain('new');
    expect(out[3]?.content).toContain('[Forge: this replaces your earlier read of src/app.ts.');
  });

  it('does not annotate or trust an errored or truncated result', () => {
    const messages: ChatMessage[] = [
      read('a', 'src/app.ts'),
      result('a', 'export const version = 1;'),
      read('b', 'src/app.ts'),
      result('b', 'Error: ENOENT'),
      read('c', 'src/app.ts'),
      result('c', 'partial\n\n[truncated by read_file — showing 10 of 99 chars]'),
    ];

    const out = annotateRereads(messages);

    // 'a' is the only complete read, so it stays as the baseline.
    expect(out[1]?.content).toBe('export const version = 1;');
    // 'b' is an error — neither triggers nor receives the note.
    expect(out[3]?.content).toBe('Error: ENOENT');
    // 'c' is truncated — neither triggers nor receives the note.
    expect(out[5]?.content).toContain('[truncated by');
    expect(out[5]?.content).not.toContain('[Forge: this replaces');
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
    expect(annotateRereads(messages)[1]?.content).toBe('contents');
  });

  it('does not mutate the input array or its messages', () => {
    const original = result('a', 'export const version = 1;');
    const messages: ChatMessage[] = [
      read('a', 'src/app.ts'),
      original,
      read('b', 'src/app.ts'),
      result('b', 'export const version = 2;'),
    ];

    const out = annotateRereads(messages);

    expect(out).not.toBe(messages);
    expect(original.content).toBe('export const version = 1;');
  });

  it('annotates the third read of a path too', () => {
    const messages: ChatMessage[] = [
      read('a', 'src/app.ts'),
      result('a', 'v1'),
      read('b', 'src/app.ts'),
      result('b', 'v2'),
      read('c', 'src/app.ts'),
      result('c', 'v3'),
    ];

    const out = annotateRereads(messages);

    expect(out[1]?.content).toBe('v1');
    expect(out[3]?.content).toContain('v2');
    expect(out[3]?.content).toContain('[Forge: this replaces');
    expect(out[5]?.content).toContain('v3');
    expect(out[5]?.content).toContain('[Forge: this replaces');
  });
});
