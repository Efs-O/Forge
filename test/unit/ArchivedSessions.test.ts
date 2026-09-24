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

  it('rebuilds a corrupt index from the bodies on disk instead of throwing', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const archive = new ArchivedSessions(root);
    archive.put({ id: 'kept', title: 'Kept', createdAt: 1, updatedAt: 1, messages: [] });
    const directory = path.join(root, 'archive');
    fs.writeFileSync(path.join(directory, 'index.json'), '[{"id": "kept", "tit');

    expect(archive.list().map((row) => row.id)).toEqual(['kept']);
    expect(fs.readdirSync(directory).some((name) => name.startsWith('index.json.corrupt-'))).toBe(true);
    // The save path keeps working on the rebuilt index.
    archive.put({ id: 'next', title: 'Next', createdAt: 2, updatedAt: 2, messages: [] });
    expect(archive.list().map((row) => row.id).sort()).toEqual(['kept', 'next']);
  });

  it('skips an unreadable or badly named body instead of failing every list', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const directory = path.join(root, 'archive');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'index.json'), '[]');
    fs.writeFileSync(path.join(directory, 'torn.json'), '{"id": "torn", "mess');
    const body = { title: 'Copy', createdAt: 1, updatedAt: 1, messages: [] };
    fs.writeFileSync(path.join(directory, 'chat (copy).json'), JSON.stringify({ id: 'x', ...body }));
    const archive = new ArchivedSessions(root);

    expect(archive.list()).toEqual([]);
    archive.put({ id: 'chat', ...body });
    expect(archive.list().map((row) => row.id)).toEqual(['chat']);
  });

  it('backfills only matching workspaces and rebuilds deduplicated user, assistant, and tool rows', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    const rows = [
      { type: 'session_start', session_id: 'from-log', title: 'Untitled chat', timestamp_ms: 10, workspace_path: 'C:/repo', model: 'm' },
      { role: 'user', content: 'question', timestamp_ms: 11 },
      { role: 'assistant', content: 'answer', timestamp_ms: 12 },
      { role: 'tool', content: 'tool result', timestamp_ms: 13 },
    ];
    fs.writeFileSync(path.join(logs, 'from-log.jsonl'), [...rows, ...rows.map((row) => ({ ...row, timestamp_ms: Number(row.timestamp_ms) + 100 }))].map((row) => JSON.stringify(row)).join('\n') + '\n{"role":"assist');
    fs.writeFileSync(path.join(logs, 'other.jsonl'), JSON.stringify({ type: 'session_start', title: 'Other', timestamp_ms: 1, workspace_path: 'C:/elsewhere' }));
    fs.writeFileSync(path.join(logs, 'current.jsonl'), JSON.stringify({ ...rows[0], session_id: 'current' }));
    fs.writeFileSync(path.join(logs, 'unknown.jsonl'), JSON.stringify({ type: 'session_start', title: 'Unknown', timestamp_ms: 1 }));
    const archive = new ArchivedSessions(path.join(root, 'storage'), 'C:/repo', logs);
    expect(archive.list(['current']).map((row) => row.id)).toEqual(['from-log']);
    const restored = archive.read('from-log');
    // Named from the first user message, not session_start's placeholder; the torn last line is skipped.
    expect(restored?.title).toBe('question');
    expect(restored?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('a permanent delete removes the log so a rebuilt index cannot bring the chat back', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    const start = { type: 'session_start', timestamp_ms: 1, workspace_path: 'C:/repo' };
    fs.writeFileSync(path.join(logs, 'gone.jsonl'), JSON.stringify(start));
    const storage = path.join(root, 'storage');
    const archive = new ArchivedSessions(storage, 'C:/repo', logs);
    expect(archive.list().map((row) => row.id)).toEqual(['gone']);
    archive.purge('gone');
    fs.rmSync(path.join(storage, 'archive', 'index.json'));
    expect(new ArchivedSessions(storage, 'C:/repo', logs).list()).toEqual([]);
    expect(fs.existsSync(path.join(logs, 'gone.jsonl'))).toBe(false);
  });

  it('a cached listing hands out copies and still sees a removed log', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    const start = { type: 'session_start', timestamp_ms: 1, workspace_path: 'C:/repo' };
    fs.writeFileSync(path.join(logs, 'kept.jsonl'), JSON.stringify(start));
    fs.writeFileSync(path.join(logs, 'lost.jsonl'), JSON.stringify(start));
    const archive = new ArchivedSessions(path.join(root, 'storage'), 'C:/repo', logs);
    archive.put({ id: 'body', title: 'Body', createdAt: 1, updatedAt: 1, messages: [] });
    expect(archive.list().map((row) => row.id).sort()).toEqual(['body', 'kept', 'lost']);
    archive.list()[0]!.title = 'mutated by a caller';
    expect(archive.list().map((row) => row.title)).not.toContain('mutated by a caller');
    fs.rmSync(path.join(logs, 'lost.jsonl'));
    expect(archive.list().map((row) => row.id).sort()).toEqual(['body', 'kept']);
  });

  it.runIf(process.platform === 'win32')('matches a log whose drive letter is lower-cased', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-'));
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'lower.jsonl'), JSON.stringify({ type: 'session_start', timestamp_ms: 1, workspace_path: 'n:\\repo' }));
    const archive = new ArchivedSessions(path.join(root, 'storage'), 'N:\\repo', logs);
    expect(archive.list().map((row) => row.id)).toEqual(['lower']);
  });
});
