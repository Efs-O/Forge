import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { legacyGlobalHistoryIds } from '../../src/sidebar/legacyGlobalHistory';
import { HistoryArchive } from '../../src/sidebar/HistoryArchive';
import { conversationToPersisted, saveSidebarSession } from '../../src/sidebar/sessionPersistence';
import { buildSessionSyncMessage } from '../../src/sidebar/sidebarPayloads';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const chat = (id: string, text = 'Original prompt'): ConversationRuntime => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 2,
  messages: [{ role: 'user', content: text }],
});
const session = (history: ConversationRuntime[]): SidebarRuntime => ({
  activeConversationId: 'blender',
  conversations: [chat('blender')],
  history,
});
function globalStore(history: ConversationRuntime[]) {
  const source = {
    activeConversationId: 'old-open',
    conversations: [conversationToPersisted(chat('old-open'))],
    history: history.map(conversationToPersisted),
  };
  return { source, get: <T>() => source as T };
}

describe('legacy global history presentation', () => {
  it('marks unchanged copies, including a chat whose close changed only retention/time metadata', () => {
    const source = globalStore([chat('old')]);
    const copy = { ...chat('old'), updatedAt: 10, retention_activity_at: 10, keep_open: false };
    const sidebar = session([copy, chat('blender-history')]);
    const before = JSON.stringify({ source: source.source, sidebar });
    const ids = legacyGlobalHistoryIds(source, sidebar);
    expect([...ids]).toEqual(['old']);
    const payload = buildSessionSyncMessage(
      sidebar,
      new Set(),
      () => 0,
      undefined,
      new Set(),
      [],
      undefined,
      undefined,
      ids,
    );
    expect(payload.history.find((row) => row.id === 'old')?.legacy_global).toBe(true);
    expect(
      payload.history.find((row) => row.id === 'blender-history')?.legacy_global,
    ).toBeUndefined();
    expect(payload.history).toHaveLength(2);
    expect(JSON.stringify({ source: source.source, sidebar })).toBe(before);
  });

  it('keeps renamed and continued copies in project history and invalidates cached classifications', () => {
    const source = globalStore([chat('old')]);
    const copy = chat('old');
    const sidebar = session([copy]);
    expect(legacyGlobalHistoryIds(source, sidebar).has('old')).toBe(true);
    copy.title = 'My Blender conversation';
    expect(legacyGlobalHistoryIds(source, sidebar).has('old')).toBe(false);
    copy.title = 'old';
    copy.messages.push({ role: 'assistant', content: 'New Blender answer' });
    copy.updatedAt += 1;
    expect(legacyGlobalHistoryIds(source, sidebar).has('old')).toBe(false);
  });

  it('retains all recent and overflow bodies through classification, save and restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-global-'));
    directories.push(directory);
    const file = path.join(directory, 'conversation-history.json');
    const archive = new HistoryArchive(file);
    const sidebar = session([chat('recent')]);
    const source = globalStore([chat('recent'), chat('overflow')]);
    const values = new Map<string, unknown>();
    const memento = {
      keys: () => [...values.keys()],
      get: <T>(key: string) => values.get(key) as T,
      update: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    };
    await saveSidebarSession(memento, sidebar, archive);
    archive.overflow.put(conversationToPersisted(chat('overflow')));
    const bodyFiles = [
      path.join(directory, 'history', 'recent.json'),
      path.join(directory, 'archive', 'overflow.json'),
    ];
    const before = bodyFiles.map((body) => fs.readFileSync(body, 'utf8'));
    expect([...legacyGlobalHistoryIds(source, sidebar, archive)].sort()).toEqual([
      'overflow',
      'recent',
    ]);
    await saveSidebarSession(memento, sidebar, archive);
    expect(bodyFiles.map((body) => fs.readFileSync(body, 'utf8'))).toEqual(before);
    const restartedArchive = new HistoryArchive(file);
    const restartedSource = globalStore([chat('recent'), chat('overflow')]);
    expect([...legacyGlobalHistoryIds(restartedSource, sidebar, restartedArchive)].sort()).toEqual([
      'overflow',
      'recent',
    ]);
    expect(restartedArchive.overflow.read('overflow')?.messages).toEqual(chat('overflow').messages);
    expect(restartedArchive.load()?.find((body) => body.id === 'recent')?.messages).toEqual(
      chat('recent').messages,
    );
    const payload = buildSessionSyncMessage(
      sidebar,
      new Set(),
      () => 0,
      undefined,
      new Set(),
      restartedArchive.overflow.list(),
      undefined,
      undefined,
      legacyGlobalHistoryIds(restartedSource, sidebar, restartedArchive),
    );
    expect(payload.archived.find((row) => row.id === 'overflow')?.legacy_global).toBe(true);
    expect(bodyFiles.map((body) => fs.readFileSync(body, 'utf8'))).toEqual(before);
  });

  it('leaves every chat visible when no legacy data exists', () => {
    expect(legacyGlobalHistoryIds(undefined, session([chat('local')])).size).toBe(0);
  });
});
