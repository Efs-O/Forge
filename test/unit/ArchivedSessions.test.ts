import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchivedSessions } from '../../src/sidebar/ArchivedSessions';

describe('ArchivedSessions', () => {
  let root: string;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('keeps the oldest of 41 archived chats readable by id', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const archive = new ArchivedSessions(root);
    for (let i = 0; i < 41; i += 1) {
      const id = `chat-${i}`;
      archive.put({ id, title: id, createdAt: i, updatedAt: i,
        messages: [{ role: 'user', content: `message ${i}` }] });
    }
    expect(archive.list()).toHaveLength(41);
    expect(archive.read('chat-0')?.messages[0]?.content).toBe('message 0');
  });

  it('renames and deletes an archived body and its index row', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const archive = new ArchivedSessions(root);
    archive.put({ id: 'chat', title: 'Before', createdAt: 1, updatedAt: 1, messages: [] });
    archive.rename('chat', 'After');
    expect(archive.read('chat')?.title).toBe('After');
    archive.delete('chat');
    expect(archive.list()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'archive', 'chat.json'))).toBe(false);
  });

  it('reindexes a body left behind by a crash before its index write', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const directory = path.join(root, 'archive');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'index.json'), '[]');
    fs.writeFileSync(path.join(directory, 'orphan.json'), JSON.stringify({
      id: 'orphan', title: 'Recovered body', createdAt: 1, updatedAt: 2,
      messages: [{ role: 'user', content: 'kept' }],
    }));
    const archive = new ArchivedSessions(root);
    expect(archive.list().map((row) => row.id)).toEqual(['orphan']);
    expect(archive.read('orphan')?.messages[0]?.content).toBe('kept');
  });

  it('backfills only matching workspaces and rebuilds deduplicated user, assistant, and tool rows', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    const rows = [
      { type: 'session_start', session_id: 'from-log', title: 'Recovered', timestamp_ms: 10, workspace_path: 'C:/repo', model: 'm' },
      { role: 'user', content: 'question', timestamp_ms: 11 },
      { role: 'assistant', content: 'answer', timestamp_ms: 12 },
      { role: 'tool', content: 'tool result', timestamp_ms: 13 },
    ];
    fs.writeFileSync(path.join(logs, 'from-log.jsonl'), [...rows, ...rows.map((row) => ({ ...row, timestamp_ms: Number(row.timestamp_ms) + 100 }))].map((row) => JSON.stringify(row)).join('\n'));
    fs.writeFileSync(path.join(logs, 'other.jsonl'), JSON.stringify({ type: 'session_start', title: 'Other', timestamp_ms: 1, workspace_path: 'C:/elsewhere' }));
    fs.writeFileSync(path.join(logs, 'current.jsonl'), JSON.stringify({ ...rows[0], session_id: 'current' }));
    fs.writeFileSync(path.join(logs, 'unknown.jsonl'), JSON.stringify({ type: 'session_start', title: 'Unknown', timestamp_ms: 1 }));
    const archive = new ArchivedSessions(path.join(root, 'storage'), 'C:/repo', logs);
    expect(archive.list(['current']).map((row) => row.id)).toEqual(['from-log']);
    const restored = archive.read('from-log');
    expect(restored?.title).toBe('Recovered');
    expect(restored?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  });
});
