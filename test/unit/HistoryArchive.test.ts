import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Memento } from 'vscode';
import { getLogger } from '../../src/util/logger';
import * as atomicWrites from '../../src/util/atomicWrite';
import { HistoryArchive, HISTORY_ARCHIVE_FILE } from '../../src/sidebar/HistoryArchive';
import { loadSidebarSession, saveSidebarSession } from '../../src/sidebar/sessionPersistence';
import { OPEN_CONVERSATIONS_KEY_V2 } from '../../src/sidebar/openConversationsPersistence';
import {
  runtimeToPersisted,
  SESSION_KEY_V1,
  type ConversationPersisted,
  type ConversationRuntime,
  type SidebarRuntime,
} from '../../src/sidebar/sessionTypes';

function makeMemento(store: Record<string, unknown>): Memento {
  return {
    get: <T>(key: string, defaultValue?: T) => {
      const value = store[key];
      return value !== undefined ? (value as T) : defaultValue;
    },
    keys: () => [],
    update: (key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
      return Promise.resolve();
    },
    setKeysForSync: () => {},
  } as unknown as Memento;
}

function conv(id: string, text: string, updatedAt = 1): ConversationRuntime {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt,
    messages: [{ role: 'user', content: text }],
  };
}

function session(history: ConversationRuntime[]): SidebarRuntime {
  return { activeConversationId: 'open', conversations: [conv('open', 'hi')], history };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function bodyDir(file: string): string {
  return path.join(path.dirname(file), 'history');
}

function bodyPath(file: string, id: string): string {
  return path.join(bodyDir(file), `${id}.json`);
}

describe('HistoryArchive', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-history-'));
    file = path.join(dir, 'ws', HISTORY_ARCHIVE_FILE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('moves a memento-held history into per-conversation files on the first save', async () => {
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(session([conv('old', 'archived')])),
    };
    const memento = makeMemento(store);
    const archive = new HistoryArchive(file);

    const loaded = loadSidebarSession(memento, archive);
    expect(loaded.history.map((conversation) => conversation.id)).toEqual(['old']);

    saveSidebarSession(memento, loaded, archive);
    await settle();
    expect((store[SESSION_KEY_V1] as { history?: unknown }).history).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(bodyPath(file, 'old'), 'utf8'))).toMatchObject({
      id: 'old',
      messages: [{ content: 'archived' }],
    });

    const reloaded = loadSidebarSession(memento, new HistoryArchive(file));
    expect(reloaded.history.map((conversation) => conversation.id)).toEqual(['old']);
    expect(reloaded.history[0]!.messages[0]!.content).toBe('archived');
  });

  // ARCHIVED_SESSIONS_PLAN's CI row: the 41st chat used to delete the oldest.
  it('evicts the oldest of 41 chats to the overflow archive instead of deleting it', () => {
    const archive = new HistoryArchive(file);
    const history = Array.from({ length: 41 }, (_, index) =>
      conv(`c${index}`, `text ${index}`, index + 1),
    );
    const current = session(history);
    saveSidebarSession(makeMemento({}), current, archive);
    expect(current.history).toHaveLength(40);
    expect(current.history.some((conversation) => conversation.id === 'c0')).toBe(false);
    expect(archive.overflow.list().map((row) => row.id)).toEqual(['c0']);
    expect(archive.overflow.read('c0')?.messages[0]?.content).toBe('text 0');
  });

  it('does not rewrite history bodies during an unchanged tool round', () => {
    const archive = new HistoryArchive(file);
    const current = session([conv('a', 'x')]);
    saveSidebarSession(makeMemento({}), current, archive);
    const body = bodyPath(file, 'a');
    fs.writeFileSync(body, 'sentinel');

    current.conversations[0]!.messages.push({ role: 'assistant', content: 'a tool round' });
    saveSidebarSession(makeMemento({}), current, archive);
    expect(fs.readFileSync(body, 'utf8')).toBe('sentinel');

    current.history.unshift(conv('b', 'closed tab', 2));
    saveSidebarSession(makeMemento({}), current, archive);
    expect(fs.readFileSync(bodyPath(file, 'b'), 'utf8')).not.toBe('sentinel');
  });

  it('writes only the newly closed conversation body', () => {
    const write = vi.spyOn(atomicWrites, 'writeFileAtomicSync');
    const archive = new HistoryArchive(file);
    const current = session([conv('a', 'first')]);
    saveSidebarSession(makeMemento({}), current, archive);
    const firstBody = fs.readFileSync(bodyPath(file, 'a'), 'utf8');

    write.mockClear();
    current.history.unshift(conv('b', 'second', 2));
    saveSidebarSession(makeMemento({}), current, archive);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe(bodyPath(file, 'b'));
    expect(fs.readdirSync(bodyDir(file)).sort()).toEqual(['a.json', 'b.json']);
    expect(fs.readFileSync(bodyPath(file, 'a'), 'utf8')).toBe(firstBody);
  });

  it('keeps a removed body until the memento write completes, then prunes it', async () => {
    const write = vi.spyOn(atomicWrites, 'writeFileAtomicSync');
    const updates: string[] = [];
    const store: Record<string, unknown> = {};
    const memento = {
      ...makeMemento(store),
      update: (key: string, value: unknown) => {
        updates.push(key);
        if (value === undefined) delete store[key];
        else store[key] = value;
        if (key === OPEN_CONVERSATIONS_KEY_V2)
          expect(fs.existsSync(bodyPath(file, 'remove'))).toBe(true);
        return Promise.resolve();
      },
    } as unknown as Memento;
    const archive = new HistoryArchive(file);
    const current = session([
      conv('keep', 'one'),
      conv('remove', 'two', 2),
      conv('stay', 'three', 3),
    ]);
    saveSidebarSession(memento, current, archive);
    await settle();

    current.history = current.history.filter((conversation) => conversation.id !== 'remove');
    updates.length = 0;
    write.mockClear();
    saveSidebarSession(memento, current, archive);
    expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(bodyPath(file, 'remove'))).toBe(true);
    expect(updates).toEqual([]);
    await settle();
    expect(updates[0]).toBe(OPEN_CONVERSATIONS_KEY_V2);
    expect(fs.existsSync(bodyPath(file, 'remove'))).toBe(false);
    expect(fs.existsSync(bodyPath(file, 'keep'))).toBe(true);
    expect(fs.existsSync(bodyPath(file, 'stay'))).toBe(true);
  });

  it('recovers an orphan body after a crash before pruning and prunes it on the next save', async () => {
    const original = new HistoryArchive(file);
    const initial = session([
      conv('keep', 'one'),
      conv('restored', 'two', 2),
      conv('stay', 'three', 3),
    ]);
    saveSidebarSession(makeMemento({}), initial, original);
    await settle();

    const open: SidebarRuntime = {
      activeConversationId: 'restored',
      conversations: [conv('restored', 'two', 2)],
      history: [],
    };
    const crashStore: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(open, { withHistory: false }),
    };
    const freshArchive = new HistoryArchive(file);
    const recovered = loadSidebarSession(makeMemento(crashStore), freshArchive);
    expect(
      recovered.conversations.filter((conversation) => conversation.id === 'restored'),
    ).toHaveLength(1);
    expect(recovered.history.some((conversation) => conversation.id === 'restored')).toBe(false);
    saveSidebarSession(makeMemento(crashStore), recovered, freshArchive);
    await settle();
    expect(fs.existsSync(bodyPath(file, 'restored'))).toBe(false);
  });

  it('keeps history in the memento and logs when a body cannot be written', async () => {
    const error = vi.spyOn(getLogger(), 'error');
    fs.mkdirSync(bodyPath(file, 'keep'), { recursive: true });
    const store: Record<string, unknown> = {};
    saveSidebarSession(makeMemento(store), session([conv('keep', 'me')]), new HistoryArchive(file));
    await settle();
    expect(
      (store[OPEN_CONVERSATIONS_KEY_V2] as { inline: Array<{ id: string }> }).inline.map(
        (item) => item.id,
      ),
    ).toEqual(['keep']);
    expect((store[SESSION_KEY_V1] as { history?: unknown }).history).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('quarantines a corrupt body, logs it, and loads the other conversations', () => {
    const error = vi.spyOn(getLogger(), 'error');
    fs.mkdirSync(bodyDir(file), { recursive: true });
    fs.writeFileSync(
      bodyPath(file, 'good'),
      JSON.stringify(runtimeToPersisted(session([conv('good', 'ok')])).history![0]),
    );
    fs.writeFileSync(bodyPath(file, 'bad'), '{not json');

    const loaded = new HistoryArchive(file).load();
    expect(loaded?.map((conversation) => conversation.id)).toEqual(['good']);
    expect(fs.existsSync(bodyPath(file, 'bad'))).toBe(false);
    expect(
      fs
        .readdirSync(bodyDir(file))
        .some((name) => name.startsWith('bad.corrupt-') && name.endsWith('.json.bad')),
    ).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable body moved'));
  });

  it('migrates legacy history and deletes it only after all bodies are written', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy: ConversationPersisted[] = [
      runtimeToPersisted(session([conv('legacy', 'from old file')])).history![0]!,
    ];
    fs.writeFileSync(file, JSON.stringify(legacy));
    const archive = new HistoryArchive(file);
    expect(archive.load()?.map((conversation) => conversation.id)).toEqual(['legacy']);
    expect(fs.existsSync(file)).toBe(true);

    expect(
      archive.save([conv('legacy', 'from old file')], (conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: [{ role: 'user', content: 'from old file' }],
      })),
    ).toBe(true);
    expect(fs.existsSync(bodyPath(file, 'legacy'))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('unions partial migrated bodies with legacy data after a crash before legacy deletion', () => {
    fs.mkdirSync(bodyDir(file), { recursive: true });
    const body = (id: string, text: string, updatedAt: number): ConversationPersisted => ({
      id,
      title: id,
      createdAt: 1,
      updatedAt,
      messages: [{ role: 'user', content: text }],
    });
    fs.writeFileSync(
      file,
      JSON.stringify([body('dir-wins-tie', 'legacy tie', 2), body('legacy-only', 'old', 1)]),
    );
    fs.writeFileSync(
      bodyPath(file, 'dir-wins-tie'),
      JSON.stringify(body('dir-wins-tie', 'directory tie', 2)),
    );
    fs.writeFileSync(bodyPath(file, 'newer'), JSON.stringify(body('newer', 'directory newer', 3)));

    const loaded = new HistoryArchive(file).load();
    expect(loaded?.map((conversation) => conversation.id).sort()).toEqual([
      'dir-wins-tie',
      'legacy-only',
      'newer',
    ]);
    expect(
      loaded?.find((conversation) => conversation.id === 'dir-wins-tie')?.messages[0]?.content,
    ).toBe('directory tie');
    expect(loaded?.find((conversation) => conversation.id === 'newer')?.messages[0]?.content).toBe(
      'directory newer',
    );
  });

  it('loads archive bodies when a non-empty memento history wins and seeds written signatures', async () => {
    const archive = new HistoryArchive(file);
    const diskHistory = [conv('already-written', 'disk', 4), conv('orphan', 'disk orphan', 3)];
    saveSidebarSession(makeMemento({}), session(diskHistory), archive);
    const winningStore: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(session([conv('already-written', 'memento', 4)])),
    };

    const loadedArchive = new HistoryArchive(file);
    const loaded = loadSidebarSession(makeMemento(winningStore), loadedArchive);
    expect(loaded.history.map((conversation) => conversation.messages[0]?.content)).toEqual([
      'memento',
    ]);
    fs.writeFileSync(bodyPath(file, 'already-written'), 'sentinel');
    saveSidebarSession(makeMemento(winningStore), loaded, loadedArchive);
    await settle();
    expect(fs.readFileSync(bodyPath(file, 'already-written'), 'utf8')).toBe('sentinel');
    expect(fs.existsSync(bodyPath(file, 'orphan'))).toBe(false);
  });

  it('quarantines an unparsable legacy archive and loads empty history', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(session([]), { withHistory: false }),
    };
    const loaded = loadSidebarSession(makeMemento(store), new HistoryArchive(file));
    expect(loaded.history).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.corrupt-')),
    ).toHaveLength(1);
  });

  it('an empty memento history does not erase the file archive', () => {
    const memento = makeMemento({});
    saveSidebarSession(memento, session([conv('kept', 'x')]), new HistoryArchive(file));
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(session([])),
    };
    const loaded = loadSidebarSession(makeMemento(store), new HistoryArchive(file));
    expect(loaded.history.map((conversation) => conversation.id)).toEqual(['kept']);
  });
});
