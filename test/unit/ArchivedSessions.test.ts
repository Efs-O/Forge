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
});
