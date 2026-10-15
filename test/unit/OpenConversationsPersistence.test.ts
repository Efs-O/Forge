import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Memento } from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../src/util/logger';
import * as atomicWrites from '../../src/util/atomicWrite';
import { HistoryArchive, HISTORY_ARCHIVE_FILE } from '../../src/sidebar/HistoryArchive';
import {
  OPEN_CONVERSATIONS_KEY_V2,
} from '../../src/sidebar/openConversationsPersistence';
import { loadSidebarSession, saveSidebarSession } from '../../src/sidebar/sessionPersistence';
import {
  runtimeToPersisted,
  SESSION_KEY_V1,
  sidebarSessionPersistedSchema,
  type ConversationPersisted,
  type ConversationRuntime,
  type SidebarRuntime,
} from '../../src/sidebar/sessionTypes';

interface HeldMemento {
  memento: Memento;
  waitForHold(): Promise<void>;
  release(): void;
}

function makeMemento(
  store: Record<string, unknown>,
  update?: (key: string, value: unknown) => Promise<void>,
): Memento {
  return {
    get: <T>(key: string, defaultValue?: T) => {
      const value = store[key];
      return value !== undefined ? (value as T) : defaultValue;
    },
    keys: () => [],
    update: (key: string, value: unknown) => {
      if (update) return update(key, value);
      if (value === undefined) delete store[key];
      else store[key] = value;
      return Promise.resolve();
    },
    setKeysForSync: () => {},
  } as unknown as Memento;
}

function holdUpdate(store: Record<string, unknown>, targetKey: string): HeldMemento {
  let releaseUpdate: (() => void) | undefined;
  let notifyHeld: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    notifyHeld = resolve;
  });
  const memento = makeMemento(store, (key, value) => {
    if (key !== targetKey) {
      if (value === undefined) delete store[key];
      else store[key] = value;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      releaseUpdate = () => {
        if (value === undefined) delete store[key];
        else store[key] = value;
        resolve();
      };
      notifyHeld?.();
    });
  });
  return {
    memento,
    waitForHold: () => held,
    release: () => releaseUpdate?.(),
  };
}

function chat(id: string, text: string, updatedAt = 1): ConversationRuntime {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt,
    messages: [{ role: 'user', content: text }],
  };
}

function sidebar(conversations: ConversationRuntime[], history: ConversationRuntime[] = []): SidebarRuntime {
  return {
    activeConversationId: conversations[0]!.id,
    conversations,
    history,
  };
}

function body(directory: string, id: string): string {
  return path.join(directory, 'open', `${id}.json`);
}

function archiveFor(directory: string): HistoryArchive {
  return new HistoryArchive(path.join(directory, HISTORY_ARCHIVE_FILE));
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 80; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

function persisted(conversation: ConversationRuntime): ConversationPersisted {
  return runtimeToPersisted(sidebar([conversation])).conversations[0]!;
}

describe('open conversations persistence', () => {
  const directories: string[] = [];

  function tempDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-open-conversations-'));
    directories.push(directory);
    return directory;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });

  it('migrates v1 bodies before v2 and shrinks v1 only after v2 commits', async () => {
    const directory = tempDirectory();
    const archive = archiveFor(directory);
    const initial = sidebar([chat('first', 'one'), chat('second', 'two', 2)]);
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: runtimeToPersisted(initial),
    };
    const held = holdUpdate(store, OPEN_CONVERSATIONS_KEY_V2);
    const loaded = loadSidebarSession(held.memento, archive);

    saveSidebarSession(held.memento, loaded, archive);
    await held.waitForHold();

    expect(fs.existsSync(body(directory, 'first'))).toBe(true);
    expect(fs.existsSync(body(directory, 'second'))).toBe(true);
    expect(store[SESSION_KEY_V1]).toEqual(runtimeToPersisted(initial));
    const afterCrashBeforeV2 = loadSidebarSession(
      makeMemento({ [SESSION_KEY_V1]: runtimeToPersisted(initial) }),
      new HistoryArchive(archive.filePath),
    );
    expect(afterCrashBeforeV2.conversations.map((conversation) => conversation.id)).toEqual([
      'first',
      'second',
    ]);

    held.release();
    await settle();
    const v2 = store[OPEN_CONVERSATIONS_KEY_V2] as {
      activeConversationId: string;
      order: string[];
      inline: ConversationPersisted[];
    };
    expect(v2.order).toEqual(['first', 'second']);
    expect(v2.inline).toEqual([]);
    expect(v2).not.toHaveProperty('messages');
    const shrunk = sidebarSessionPersistedSchema.parse(store[SESSION_KEY_V1]);
    expect(shrunk.conversations).toHaveLength(1);
    expect(shrunk.conversations[0]!.messages).toEqual([]);
    expect(shrunk).not.toHaveProperty('history');
  });

  it('writes only the changed chat on a tool round and skips an unchanged save', async () => {
    const directory = tempDirectory();
    const archive = archiveFor(directory);
    const current = sidebar([chat('active', 'first'), chat('other', 'second', 2)]);
    const store: Record<string, unknown> = {};
    const memento = makeMemento(store);
    saveSidebarSession(memento, current, archive);
    await settle();

    const write = vi.spyOn(atomicWrites, 'writeFileAtomicSync');
    current.conversations[0]!.messages.push({ role: 'assistant', content: 'tool round result' });
    saveSidebarSession(memento, current, archive, 'active');
    await settle();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe(body(directory, 'active'));
    expect((store[OPEN_CONVERSATIONS_KEY_V2] as { inline: unknown[] }).inline).toEqual([]);

    write.mockClear();
    saveSidebarSession(memento, current, archive);
    await settle();
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a body inline and logs when its atomic file write fails', async () => {
    const directory = tempDirectory();
    const archive = archiveFor(directory);
    const current = sidebar([chat('failed', 'still recoverable')]);
    const store: Record<string, unknown> = {};
    const error = vi.spyOn(getLogger(), 'error');
    const actualWrite = atomicWrites.writeFileAtomicSync;
    vi.spyOn(atomicWrites, 'writeFileAtomicSync').mockImplementation((target, content, expected) => {
      if (target === body(directory, 'failed')) throw new Error('disk full');
      actualWrite(target, content, expected);
    });

    saveSidebarSession(makeMemento(store), current, archive);
    await settle();

    expect(fs.existsSync(body(directory, 'failed'))).toBe(false);
    expect((store[OPEN_CONVERSATIONS_KEY_V2] as { inline: ConversationPersisted[] }).inline).toEqual([
      persisted(current.conversations[0]!),
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not write failed'));
  });

  it('quarantines a corrupt open body while the other ordered chats load', () => {
    const directory = tempDirectory();
    const archive = archiveFor(directory);
    const openDirectory = path.join(directory, 'open');
    fs.mkdirSync(openDirectory, { recursive: true });
    fs.writeFileSync(body(directory, 'good'), JSON.stringify(persisted(chat('good', 'ok'))));
    fs.writeFileSync(body(directory, 'bad'), '{not json');
    const error = vi.spyOn(getLogger(), 'error');
    const store = {
      [OPEN_CONVERSATIONS_KEY_V2]: {
        activeConversationId: 'good',
        order: ['good', 'bad'],
        inline: [],
      },
    };

    const loaded = loadSidebarSession(makeMemento(store), archive);

    expect(loaded.conversations.map((conversation) => conversation.id)).toEqual(['good']);
    expect(fs.existsSync(body(directory, 'bad'))).toBe(false);
    expect(fs.readdirSync(openDirectory).some((name) => /^bad\.corrupt-\d+\.json\.bad$/.test(name))).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable body moved'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('missing body for open conversation bad'));
  });

  it('ignores an orphan atomic-write temp and reads the previous whole body', () => {
    const directory = tempDirectory();
    const archive = archiveFor(directory);
    fs.mkdirSync(path.join(directory, 'open'), { recursive: true });
    fs.writeFileSync(body(directory, 'chat'), JSON.stringify(persisted(chat('chat', 'whole'))));
    const temporary = path.join(directory, 'open', '.chat.json.forge-123-0.tmp');
    fs.writeFileSync(temporary, '{partial');
    const store = {
      [OPEN_CONVERSATIONS_KEY_V2]: {
        activeConversationId: 'chat',
        order: ['chat'],
        inline: [],
      },
    };

    const loaded = loadSidebarSession(makeMemento(store), archive);

    expect(loaded.conversations[0]!.messages[0]!.content).toBe('whole');
    expect(fs.readFileSync(temporary, 'utf8')).toBe('{partial');
  });

  it('uses a newer inline copy and keeps the disk copy on an updatedAt tie', () => {
    const directory = tempDirectory();
    const disk = chat('chat', 'disk body', 1);
    fs.mkdirSync(path.join(directory, 'open'), { recursive: true });
    fs.writeFileSync(body(directory, 'chat'), JSON.stringify(persisted(disk)));
    const store: Record<string, unknown> = {
      [OPEN_CONVERSATIONS_KEY_V2]: {
        activeConversationId: 'chat',
        order: ['chat'],
        inline: [persisted(chat('chat', 'new inline body', 2))],
      },
    };

    const newer = loadSidebarSession(makeMemento(store), archiveFor(directory));
    expect(newer.conversations[0]!.messages[0]!.content).toBe('new inline body');

    store[OPEN_CONVERSATIONS_KEY_V2] = {
      activeConversationId: 'chat',
      order: ['chat'],
      inline: [persisted(chat('chat', 'inline tie', 1))],
    };
    const tie = loadSidebarSession(makeMemento(store), archiveFor(directory));
    expect(tie.conversations[0]!.messages[0]!.content).toBe('disk body');
  });

  it('removes a deleted open body only after the v2 memento commits', async () => {
    const directory = tempDirectory();
    const archive = archiveFor(directory);
    const current = sidebar([chat('keep', 'one'), chat('remove', 'two', 2)]);
    const store: Record<string, unknown> = {};
    const memento = makeMemento(store);
    saveSidebarSession(memento, current, archive);
    await settle();

    const held = holdUpdate(store, OPEN_CONVERSATIONS_KEY_V2);
    current.conversations = [current.conversations[0]!];
    saveSidebarSession(held.memento, current, archive);
    await held.waitForHold();
    expect(fs.existsSync(body(directory, 'remove'))).toBe(true);

    held.release();
    await settle();
    expect(fs.existsSync(body(directory, 'remove'))).toBe(false);
    expect(fs.existsSync(body(directory, 'keep'))).toBe(true);
  });

  it('rebuilds pending removals from orphan files after a crash', async () => {
    const directory = tempDirectory();
    const archive = archiveFor(directory);
    fs.mkdirSync(path.join(directory, 'open'), { recursive: true });
    const keep = chat('keep', 'current');
    fs.writeFileSync(body(directory, 'keep'), JSON.stringify(persisted(keep)));
    fs.writeFileSync(body(directory, 'orphan'), JSON.stringify(persisted(chat('orphan', 'old', 2))));
    const seed = chat('seed', '');
    seed.messages = [];
    const store: Record<string, unknown> = {
      [OPEN_CONVERSATIONS_KEY_V2]: {
        activeConversationId: 'keep',
        order: ['keep'],
        inline: [],
      },
      [SESSION_KEY_V1]: runtimeToPersisted(sidebar([seed]), { withHistory: false }),
    };
    const memento = makeMemento(store);
    const loaded = loadSidebarSession(memento, archive);
    expect(loaded.conversations.map((conversation) => conversation.id)).toEqual(['keep']);

    saveSidebarSession(memento, loaded, archive);
    await settle();
    expect(fs.existsSync(body(directory, 'orphan'))).toBe(false);
    expect(fs.existsSync(body(directory, 'keep'))).toBe(true);
  });

  it('keeps a moved chat in both directories until v2 commits, so a crash can recover it', async () => {
    const directory = tempDirectory();
    const archiveFile = path.join(directory, HISTORY_ARCHIVE_FILE);
    const archive = new HistoryArchive(archiveFile);
    const moving = chat('moving', 'transcript');
    const current = sidebar([moving, chat('active', '')]);
    current.activeConversationId = 'active';
    const store: Record<string, unknown> = {};
    const memento = makeMemento(store);
    saveSidebarSession(memento, current, archive);
    await settle();

    const held = holdUpdate(store, OPEN_CONVERSATIONS_KEY_V2);
    current.conversations = [current.conversations[1]!];
    current.history = [moving];
    saveSidebarSession(held.memento, current, archive);
    await held.waitForHold();

    const historyBody = path.join(directory, 'history', 'moving.json');
    expect(fs.existsSync(body(directory, 'moving'))).toBe(true);
    expect(fs.existsSync(historyBody)).toBe(true);
    const recovered = loadSidebarSession(makeMemento(store), new HistoryArchive(archiveFile));
    expect(recovered.conversations.some((conversation) => conversation.id === 'moving')).toBe(true);
    expect(recovered.history.some((conversation) => conversation.id === 'moving')).toBe(false);

    held.release();
    await settle();
    expect(fs.existsSync(body(directory, 'moving'))).toBe(false);
    expect(fs.existsSync(historyBody)).toBe(true);
  });

  it('merges message-bearing v1 chats on upgrade and shrinks v1 again', async () => {
    const directory = tempDirectory();
    const archive = archiveFor(directory);
    const existing = chat('existing', 'new build chat');
    fs.mkdirSync(path.join(directory, 'open'), { recursive: true });
    fs.writeFileSync(body(directory, 'existing'), JSON.stringify(persisted(existing)));
    const downgraded = chat('from-old-build', 'work done while downgraded', 5);
    const oldV1 = runtimeToPersisted(sidebar([downgraded]), { withHistory: false });
    const store: Record<string, unknown> = {
      [OPEN_CONVERSATIONS_KEY_V2]: {
        activeConversationId: 'existing',
        order: ['existing'],
        inline: [],
      },
      [SESSION_KEY_V1]: oldV1,
    };
    const memento = makeMemento(store);

    const loaded = loadSidebarSession(memento, archive);
    expect(loaded.conversations.map((conversation) => conversation.id)).toEqual([
      'existing',
      'from-old-build',
    ]);
    expect(loaded.activeConversationId).toBe('existing');

    saveSidebarSession(memento, loaded, archive);
    await settle();
    expect(fs.existsSync(body(directory, 'from-old-build'))).toBe(true);
    expect((store[OPEN_CONVERSATIONS_KEY_V2] as { order: string[] }).order).toEqual([
      'existing',
      'from-old-build',
    ]);
    const shrunk = sidebarSessionPersistedSchema.parse(store[SESSION_KEY_V1]);
    expect(shrunk.conversations).toHaveLength(1);
    expect(shrunk.conversations[0]!.messages).toEqual([]);
    expect(shrunk).not.toHaveProperty('history');
  });

  it('keeps open and history bodies inline when no workspace storage directory exists', async () => {
    const current = sidebar([chat('open', 'open body')], [chat('history', 'history body', 2)]);
    const store: Record<string, unknown> = {};
    saveSidebarSession(makeMemento(store), current);
    await settle();

    const v2 = store[OPEN_CONVERSATIONS_KEY_V2] as { order: string[]; inline: ConversationPersisted[] };
    expect(v2.order).toEqual(['open']);
    expect(v2.inline.map((conversation) => conversation.id).sort()).toEqual(['history', 'open']);
  });
});
