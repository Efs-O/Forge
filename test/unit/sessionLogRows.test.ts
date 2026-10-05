import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionLogRows } from '../../src/sessions/sessionLogRows';

describe('readSessionLogRows', () => {
  let root: string;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function readRows(rows: Array<Record<string, unknown>>, suffix = ''): Array<Record<string, unknown>> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-session-rows-'));
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + suffix, 'utf8');
    return readSessionLogRows(file);
  }

  it('counts a legacy replayed transcript only once', () => {
    const block = [
      { type: 'session_start', timestamp_ms: 1 },
      { role: 'user', content: 'hello', timestamp_ms: 2 },
      { role: 'assistant', content: 'hi', timestamp_ms: 3 },
    ];
    const replay = block.map((row) => ({ ...row, timestamp_ms: Number(row.timestamp_ms) + 100 }));

    expect(readRows([...block, ...replay]).map((row) => row['role'] ?? row['type'])).toEqual([
      'session_start', 'user', 'assistant',
    ]);
  });

  it('skips cursor-position rows replayed after a cursor', () => {
    const rows = [
      { role: 'user', content: 'hello', timestamp_ms: 1 },
      { role: 'assistant', content: 'hi', timestamp_ms: 2 },
      { type: 'cursor', written_count: 2, timestamp_ms: 3 },
      { role: 'user', content: 'hello', timestamp_ms: 101 },
      { role: 'assistant', content: 'hi', timestamp_ms: 102 },
    ];

    expect(readRows(rows).map((row) => row['role'] ?? row['type'])).toEqual([
      'user', 'assistant', 'cursor',
    ]);
  });

  it('skips a torn final line', () => {
    const rows = readRows([
      { role: 'user', content: 'kept', timestamp_ms: 1 },
    ], '\n{"role":"assistant","content":');

    expect(rows.map((row) => row['role'])).toEqual(['user']);
  });
});
