import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import { HistoryArchive, HISTORY_ARCHIVE_FILE } from '../../src/sidebar/HistoryArchive';
import {
  loadSidebarSession,
  runtimeToPersisted,
  saveSidebarSession,
  SESSION_KEY_V1,
  type ConversationRuntime,
  type SidebarRuntime,
} from '../../src/sidebar/sessionTypes';

function makeMemento(store: Record<string, unknown>): Memento {
  return {
    get: <T>(key: string, defaultValue?: T) => {
      const v = store[key];
      return v !== undefined ? (v as T) : defaultValue;
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
  // persistMemento chains updates on promises; let them run.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function persistedHistory(store: Record<string, unknown>): unknown {
  return (store[SESSION_KEY_V1] as { history?: unknown }).history;
}

describe('HistoryArchive', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-history-'));
    file = path.join(dir, 'ws', HISTORY_ARCHIVE_FILE);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('moves a memento-held history into the file on the first save', async () => {
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(session([conv('old', 'archived')])),
    };
    const memento = makeMemento(store);
    const archive = new HistoryArchive(file);

    const loaded = loadSidebarSession(memento, archive);
    expect(loaded.history.map((c) => c.id)).toEqual(['old']);

    saveSidebarSession(memento, loaded, archive);
    await settle();
    expect(persistedHistory(store)).toBeUndefined();
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ id: string }>;
    expect(onDisk.map((c) => c.id)).toEqual(['old']);

    const reloaded = loadSidebarSession(memento, new HistoryArchive(file));
    expect(reloaded.history.map((c) => c.id)).toEqual(['old']);
    expect(reloaded.history[0]!.messages[0]!.content).toBe('archived');
  });

  it('does not rewrite the file while the history is unchanged', () => {
    const memento = makeMemento({});
    const archive = new HistoryArchive(file);
    const s = session([conv('a', 'x')]);
    saveSidebarSession(memento, s, archive);
    fs.writeFileSync(file, 'sentinel');

    s.conversations[0]!.messages.push({ role: 'assistant', content: 'a tool round' });
    saveSidebarSession(memento, s, archive);
    expect(fs.readFileSync(file, 'utf8')).toBe('sentinel');

    s.history.unshift(conv('b', 'closed tab', 2));
    saveSidebarSession(memento, s, archive);
    expect(fs.readFileSync(file, 'utf8')).not.toBe('sentinel');
  });

  it('keeps history in the memento when the file cannot be written', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(file); // a directory where the file should be: rename fails
    const store: Record<string, unknown> = {};
    saveSidebarSession(makeMemento(store), session([conv('keep', 'me')]), new HistoryArchive(file));
    await settle();
    expect((persistedHistory(store) as Array<{ id: string }>).map((c) => c.id)).toEqual(['keep']);
  });

  it('quarantines an unparsable file and loads an empty history', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(session([]), { withHistory: false }),
    };
    const loaded = loadSidebarSession(makeMemento(store), new HistoryArchive(file));
    expect(loaded.history).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    const aside = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
  });

  it('an empty memento history does not erase the file archive', () => {
    const memento = makeMemento({});
    saveSidebarSession(memento, session([conv('kept', 'x')]), new HistoryArchive(file));
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(session([])),
    };
    const loaded = loadSidebarSession(makeMemento(store), new HistoryArchive(file));
    expect(loaded.history.map((c) => c.id)).toEqual(['kept']);
  });
});
