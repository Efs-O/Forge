import { describe, expect, it } from 'vitest';
import {
  findPendingToolRow,
  mergeSyncedMessages,
  type AppMessage,
  type PersistedRow,
} from '../../webview-ui/src/messageOps';

function msg(
  role: AppMessage['role'],
  content: string,
  extra: Partial<AppMessage> = {},
): AppMessage {
  return { id: `${role}-${content}`, role, content, ...extra };
}

describe('mergeSyncedMessages', () => {
  it('restores a completed tool row from the host', () => {
    const local: AppMessage[] = [
      msg('user', 'do it'),
      msg('tool', 'read_file → src/a.ts', {
        toolName: 'read_file',
        toolResult: 'contents',
        toolResultTotal: 8,
      }),
      msg('assistant', 'done'),
    ];
    const rows: PersistedRow[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'tool',
        content: 'read_file → src/a.ts',
        toolName: 'read_file',
        toolResult: 'contents',
        toolResultTotal: 8,
      },
      { role: 'assistant', content: 'done' },
    ];

    expect(mergeSyncedMessages(local, rows).map((m) => m.role)).toEqual([
      'user',
      'tool',
      'assistant',
    ]);
  });

  it('keeps an in-flight tool row until the host has a completed result', () => {
    const local: AppMessage[] = [
      msg('user', 'do it'),
      msg('tool', 'read_file → src/a.ts', { toolName: 'read_file' }),
    ];
    const rows: PersistedRow[] = [{ role: 'user', content: 'do it' }];

    expect(mergeSyncedMessages(local, rows).map((m) => m.role)).toEqual(['user', 'tool']);
  });

  it('keeps diffs and errors interleaved rather than appended to the tail', () => {
    const local: AppMessage[] = [
      msg('user', 'go'),
      msg('diff', 'src/a.ts'),
      msg('assistant', 'first'),
      msg('error', 'boom'),
      msg('assistant', 'second'),
    ];
    const rows: PersistedRow[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'first' },
      { role: 'assistant', content: 'second' },
    ];

    expect(mergeSyncedMessages(local, rows).map((m) => m.role)).toEqual([
      'user',
      'diff',
      'assistant',
      'error',
      'assistant',
    ]);
  });

  it('uses the synchronized diff preview instead of dropping it at turn completion', () => {
    const local: AppMessage[] = [
      msg('user', 'edit it'),
      msg('tool', 'write_file → src/a.ts', {
        toolName: 'write_file',
        toolResult: 'written',
        toolResultTotal: 7,
      }),
      msg('diff', 'src/a.ts'),
      msg('assistant', 'Done.'),
    ];
    const rows: PersistedRow[] = [
      { role: 'user', content: 'edit it' },
      {
        role: 'tool',
        content: 'write_file → src/a.ts',
        toolName: 'write_file',
        toolResult: 'written',
        toolResultTotal: 7,
      },
      {
        role: 'diff',
        content: 'src/a.ts',
        diffHunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'added', text: 'x' }] }],
        diffIsNew: false,
        diffIsDeleted: false,
      },
      { role: 'assistant', content: 'Done.' },
    ];

    const merged = mergeSyncedMessages(local, rows);
    expect(merged.map((m) => m.role)).toEqual(['user', 'tool', 'diff', 'assistant']);
    expect(merged[2]!.diffHunks?.[0]?.lines[0]?.text).toBe('x');
  });

  it('takes the host content for persisted rows', () => {
    const local: AppMessage[] = [msg('assistant', 'stale')];
    const rows: PersistedRow[] = [{ role: 'assistant', content: 'authoritative' }];

    expect(mergeSyncedMessages(local, rows)[0]!.content).toBe('authoritative');
  });

  it('reuses ids for matching rows so React keeps component state', () => {
    const local: AppMessage[] = [msg('user', 'go'), msg('tool', 't'), msg('assistant', 'a')];
    const rows: PersistedRow[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'a' },
    ];

    const merged = mergeSyncedMessages(local, rows);
    expect(merged[0]!.id).toBe(local[0]!.id);
    expect(merged[2]!.id).toBe(local[2]!.id);
  });

  it('hydrates an empty conversation straight from the host', () => {
    const rows: PersistedRow[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(mergeSyncedMessages([], rows).map((m) => m.content)).toEqual(['hello', 'hi']);
  });

  it('anchors local-only rows before the next matching host turn', () => {
    // The host can omit or replace intermediate renderable turns.
    const local: AppMessage[] = [
      msg('user', 'one'),
      msg('assistant', 'two'),
      msg('tool', 'read_file'),
      msg('user', 'three'),
    ];
    const rows: PersistedRow[] = [{ role: 'user', content: 'three' }];

    const merged = mergeSyncedMessages(local, rows);
    expect(merged.map((m) => m.role)).toEqual(['tool', 'user']);
    expect(merged[1]!.content).toBe('three');
  });

  it('keeps tool activity before the final report when an intermediate assistant turn is omitted', () => {
    const local: AppMessage[] = [
      msg('user', 'update the docs'),
      msg('assistant', '', { reasoning: 'I will inspect the files first.' }),
      msg('tool', 'read_file → docs/README.md', { toolName: 'read_file' }),
      msg('tool', 'replace_in_file → docs/README.md', { toolName: 'replace_in_file' }),
      msg('assistant', 'Docs updated.'),
    ];
    // Assistant tool-call turns may have no renderable content in the host
    // view, but their tool activity must remain before the final response.
    const rows: PersistedRow[] = [
      { role: 'user', content: 'update the docs' },
      { role: 'assistant', content: 'Docs updated.' },
    ];

    expect(mergeSyncedMessages(local, rows).map((m) => m.role)).toEqual([
      'user',
      'tool',
      'tool',
      'assistant',
    ]);
  });

  it('preserves reasoning carried by the host', () => {
    const rows: PersistedRow[] = [{ role: 'assistant', content: '', reasoning: 'thought' }];
    expect(mergeSyncedMessages([], rows)[0]!.reasoning).toBe('thought');
  });
});

describe('findPendingToolRow', () => {
  it('finds the newest unresolved row for that tool', () => {
    const messages: AppMessage[] = [
      msg('tool', 'read_file → a', { toolName: 'read_file', toolResult: 'done' }),
      msg('tool', 'read_file → b', { toolName: 'read_file' }),
      msg('assistant', 'text'),
    ];
    expect(findPendingToolRow(messages, 'read_file')).toBe(1);
  });

  it('returns -1 when every row for that tool already has a result', () => {
    const messages: AppMessage[] = [
      msg('tool', 'read_file → a', { toolName: 'read_file', toolResult: 'done' }),
    ];
    expect(findPendingToolRow(messages, 'read_file')).toBe(-1);
    expect(findPendingToolRow(messages, 'write_file')).toBe(-1);
  });
});
