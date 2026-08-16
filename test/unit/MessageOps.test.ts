import { describe, expect, it } from 'vitest';
import {
  findPendingToolRow,
  mergeSyncedMessages,
  type AppMessage,
  type PersistedRow,
} from '../../webview-ui/src/messageOps';

function msg(role: AppMessage['role'], content: string, extra: Partial<AppMessage> = {}): AppMessage {
  return { id: `${role}-${content}`, role, content, ...extra };
}

describe('mergeSyncedMessages', () => {
  it('keeps tool rows in position instead of dropping them', () => {
    const local: AppMessage[] = [
      msg('user', 'do it'),
      msg('tool', 'read_file → src/a.ts', { toolName: 'read_file' }),
      msg('assistant', 'done'),
    ];
    const rows: PersistedRow[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'done' },
    ];

    expect(mergeSyncedMessages(local, rows).map((m) => m.role)).toEqual([
      'user',
      'tool',
      'assistant',
    ]);
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

  it('falls back to host order when the two views disagree', () => {
    // Compaction: the host dropped a turn the webview still holds.
    const local: AppMessage[] = [
      msg('user', 'one'),
      msg('assistant', 'two'),
      msg('tool', 'read_file'),
      msg('user', 'three'),
    ];
    const rows: PersistedRow[] = [{ role: 'user', content: 'three' }];

    const merged = mergeSyncedMessages(local, rows);
    expect(merged.map((m) => m.role)).toEqual(['user', 'tool']);
    expect(merged[0]!.content).toBe('three');
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
