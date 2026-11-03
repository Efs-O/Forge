import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  chatsForSession,
  findBySession,
  findSessionChatIn,
  forgetConversation,
  link,
  rebuildIndex,
  unlink,
  type AgentKind,
  type AgentLink,
} from '../../src/agentLinks/chatAgentLinks';
import { HistoryArchive, HISTORY_ARCHIVE_FILE } from '../../src/sidebar/HistoryArchive';
import { ConversationTabs, type ConversationTabsDeps } from '../../src/sidebar/ConversationTabs';
import {
  loadSidebarSession,
  persistedToRuntime,
  saveSidebarSession,
} from '../../src/sidebar/sessionPersistence';
import {
  runtimeToPersisted,
  SESSION_KEY_V1,
  type ConversationRuntime,
  type SidebarRuntime,
} from '../../src/sidebar/sessionTypes';
import type { Memento } from 'vscode';

function conversation(id: string, title = id): ConversationRuntime {
  return { id, title, createdAt: 1, updatedAt: 1, messages: [] };
}

function sessionLink(kind: AgentKind, sessionId: string): AgentLink {
  return {
    kind,
    sessionId,
    cwd: '/workspace',
    title: `${kind} session`,
    linkedAt: 10,
    lastUsedAt: 10,
    origin: 'user-set',
  };
}

function memento(store: Record<string, unknown>): Memento {
  return {
    get: <T>(key: string, defaultValue?: T) =>
      store[key] === undefined ? defaultValue : (store[key] as T),
    keys: () => Object.keys(store),
    update: async (key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
    },
    setKeysForSync: () => {},
  } as unknown as Memento;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(target)
      : entry.isFile() && entry.name.endsWith('.ts')
        ? [target]
        : [];
  });
}

describe('chat agent link ownership', () => {
  it('keeps agentLinks writes in the owner module', () => {
    const sourceRoot = path.resolve('src');
    const owner = path.resolve('src/agentLinks/chatAgentLinks.ts');
    const writes = /(?:\.agentLinks|\[['"]agentLinks['"]\])\s*=(?!=|>)/u;
    const violations = sourceFiles(sourceRoot).filter(
      (file) => file !== owner && writes.test(fs.readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('keeps the deleted alias ownership layer out of source', () => {
    const sourceRoot = path.resolve('src');
    const obsolete = /ownershipPath|aliasRegistry/u;
    const violations = sourceFiles(sourceRoot).filter((file) =>
      obsolete.test(fs.readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('links, unlinks, and rebuilds the session index', () => {
    const first = conversation('first');
    const second = conversation('second');
    const claude = sessionLink('claude', '00000000-0000-4000-8000-000000000001');
    rebuildIndex([]);

    link(first, claude);
    expect(unlink(first, 'claude')).toEqual(claude);
    expect(findBySession(claude.sessionId)).toBeUndefined();
    link(second, claude);
    // A second chat is no longer refused, and the first one can be linked
    // beside it: both are now in the session's set.
    link(first, claude);
    expect(chatsForSession(claude.sessionId).sort()).toEqual(['first', 'second']);
    expect(findBySession(claude.sessionId)).toBeDefined();

    rebuildIndex([first, second]);
    expect(chatsForSession(claude.sessionId).sort()).toEqual(['first', 'second']);
  });

  it('links the same session to two chats instead of refusing the second', () => {
    const first = conversation('first', 'First chat');
    const second = conversation('second', 'Second chat');
    const codex = sessionLink('codex', '00000000-0000-4000-8000-000000000002');
    rebuildIndex([]);
    link(first, codex);

    expect(() => link(second, codex)).not.toThrow();
    expect(first.agentLinks?.codex?.sessionId).toBe(codex.sessionId);
    expect(second.agentLinks?.codex?.sessionId).toBe(codex.sessionId);
    // A chat still holds one link per kind, so re-linking a chat frees it from
    // the session it was holding — and only that chat, not the other one.
    const otherSession = sessionLink('codex', '00000000-0000-4000-8000-000000000009');
    link(second, otherSession);
    expect(chatsForSession(codex.sessionId)).toEqual(['first']);
    expect(chatsForSession(otherSession.sessionId)).toEqual(['second']);
  });

  it('rebuilds archived reverse-index entries from metadata without reading bodies', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-links-'));
    try {
      const archive = new HistoryArchive(path.join(directory, HISTORY_ARCHIVE_FILE));
      const archived: ConversationRuntime = {
        ...conversation('archived', 'Archived chat'),
        agentLinks: {
          codex: sessionLink('codex', '00000000-0000-4000-8000-000000000004'),
        },
      };
      archive.overflow.put({
        id: archived.id,
        title: archived.title,
        createdAt: archived.createdAt,
        updatedAt: archived.updatedAt,
        messages: [],
        agentLinks: archived.agentLinks,
      });
      const read = vi.spyOn(archive.overflow, 'read');

      loadSidebarSession(memento({}), archive);

      expect(read).not.toHaveBeenCalled();
      const other = conversation('other', 'Other chat');
      // Several chats holding one session is normal now, so the archived
      // chat's claim does not stop another chat from being linked beside it.
      link(other, archived.agentLinks!.codex!);
      expect(chatsForSession(archived.agentLinks!.codex!.sessionId).sort()).toEqual([
        'archived',
        'other',
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rebuilds every chat link on load and makes the newest the current one', () => {
    const sessionId = '00000000-0000-4000-8000-000000000005';
    const first: ConversationRuntime = {
      ...conversation('first', 'Older chat'),
      agentLinks: {
        claude: {
          ...sessionLink('claude', sessionId),
          lastUsedAt: 10,
        },
      },
    };
    const second: ConversationRuntime = {
      ...conversation('second', 'Newer chat'),
      agentLinks: {
        claude: {
          ...sessionLink('claude', sessionId),
          lastUsedAt: 20,
        },
      },
    };
    const state: SidebarRuntime = {
      activeConversationId: first.id,
      conversations: [first, second],
      history: [],
    };

    expect(() =>
      loadSidebarSession(memento({ [SESSION_KEY_V1]: runtimeToPersisted(state) }), undefined),
    ).not.toThrow();
    // One session in two chats is no longer a conflict to report or to
    // resolve: the load rebuilds both, newest `lastUsedAt` is the chat the
    // session addresses next, and either chat can be addressed again.
    expect(chatsForSession(sessionId).sort()).toEqual(['first', 'second']);
    expect(findBySession(sessionId)).toBe('second');
    expect(() => link(first, first.agentLinks!.claude!)).not.toThrow();
  });

  it('unlinking one chat leaves the rest linked and moves current to the newest', () => {
    const sessionId = '00000000-0000-4000-8000-000000000008';
    const older = conversation('older', 'Older chat');
    const current = conversation('current', 'Current chat');
    rebuildIndex([]);
    link(older, { ...sessionLink('claude', sessionId), lastUsedAt: 10 });
    link(current, { ...sessionLink('claude', sessionId), lastUsedAt: 20 });
    expect(findBySession(sessionId)).toBe('current');

    expect(unlink(current, 'claude')).toBeDefined();
    expect(chatsForSession(sessionId)).toEqual(['older']);
    expect(findBySession(sessionId)).toBe('older');
    expect(older.agentLinks?.claude?.sessionId).toBe(sessionId);
  });

  it('findSessionChatIn takes the newest chat whose own link names the sender', () => {
    const sessionId = '00000000-0000-4000-8000-000000000011';
    const held: ConversationRuntime = {
      ...conversation('held', 'Held chat'),
      agentLinks: { claude: { ...sessionLink('claude', sessionId), lastUsedAt: 10 } },
    };
    const elsewhere: ConversationRuntime = {
      ...conversation('elsewhere', 'Another window'),
      agentLinks: { claude: { ...sessionLink('claude', sessionId), lastUsedAt: 99 } },
    };
    rebuildIndex([held, elsewhere]);
    // Only the chats this window has are offered to `linkOf`; the index is
    // process-wide and knows about both.
    const windowLinks: Record<string, AgentLink | undefined> = {
      held: held.agentLinks!.claude!,
    };
    const linkOf = (id: string): AgentLink | undefined => windowLinks[id];
    expect(findSessionChatIn(sessionId, 'claude', linkOf)).toBe('held');
    // Newest wins as soon as the window holds it too.
    windowLinks['elsewhere'] = elsewhere.agentLinks!.claude!;
    expect(findSessionChatIn(sessionId, 'claude', linkOf)).toBe('elsewhere');
    // A link naming a different session is not this sender's, even when it is
    // the newest, so the caller gets undefined rather than somebody else's chat.
    expect(
      findSessionChatIn(sessionId, 'claude', () =>
        sessionLink('claude', '00000000-0000-4000-8000-000000000012'),
      ),
    ).toBeUndefined();
  });

  it('a deleted chat leaves the session linked to the chats that survive', () => {
    const sessionId = '00000000-0000-4000-8000-000000000010';
    const kept = conversation('kept', 'Kept chat');
    const gone = conversation('gone', 'Gone chat');
    rebuildIndex([]);
    link(kept, { ...sessionLink('claude', sessionId), lastUsedAt: 10 });
    link(gone, { ...sessionLink('claude', sessionId), lastUsedAt: 20 });
    expect(findBySession(sessionId)).toBe('gone');

    forgetConversation('gone');

    expect(chatsForSession(sessionId)).toEqual(['kept']);
    expect(findBySession(sessionId)).toBe('kept');
    expect(kept.agentLinks?.claude?.sessionId).toBe(sessionId);
  });

  it('/clearChat keeps links and a newly created conversation starts without them', () => {
    const active = conversation('active', 'Active chat');
    link(active, sessionLink('copilot', 'copilot-session-1'));
    const linksBeforeClear = { ...active.agentLinks };
    let sidebar: SidebarRuntime = {
      activeConversationId: active.id,
      conversations: [active],
      history: [],
    };
    const tabs = new ConversationTabs({
      isStreaming: () => false,
      getConfig: () => ({ active_model: null }),
      getSidebar: () => sidebar,
      setSidebar: (next) => {
        sidebar = next;
      },
      failureTracker: { reset: vi.fn() },
      refreshUi: vi.fn(),
      isConversationEvictable: () => true,
      evictionBlockers: () => [],
      isConversationDrafted: () => false,
      retention: { markActivity: vi.fn(), refresh: vi.fn(), isExpired: () => false, isEnabled: () => true },
      persistSidebar: async () => true,
      agentLoop: { stopStreamingIfNeeded: vi.fn(), disposeConversation: vi.fn() },
      post: vi.fn(),
    } as unknown as ConversationTabsDeps);

    tabs.clearActive();
    expect(sidebar.conversations[0]?.agentLinks).toEqual(linksBeforeClear);
    const created = tabs.create();
    expect(created?.agentLinks).toBeUndefined();
  });

  // An empty chat is dropped, not archived. Its link stayed in the index, and
  // every later message from that session failed with "linked chat … is
  // unavailable", `--new` and `--to` included (2026-10-19).
  describe('a dropped empty chat frees its session', () => {
    const sessionId = '00000000-0000-4000-8000-000000000006';

    function tabsOver(chats: ConversationRuntime[]): {
      tabs: ConversationTabs;
      sidebar: () => SidebarRuntime;
    } {
      rebuildIndex([]);
      let sidebar: SidebarRuntime = {
        activeConversationId: chats[0]!.id,
        conversations: chats,
        history: [],
      };
      const tabs = new ConversationTabs({
        isStreaming: () => false,
        getConfig: () => ({ active_model: null }),
        getSidebar: () => sidebar,
        setSidebar: (next) => {
          sidebar = next;
        },
        failureTracker: { reset: vi.fn() },
        refreshUi: vi.fn(),
        isConversationEvictable: () => true,
        evictionBlockers: () => [],
        isConversationDrafted: () => false,
        retention: { markActivity: vi.fn(), refresh: vi.fn(), isExpired: () => false, isEnabled: () => true },
        persistSidebar: async () => true,
        agentLoop: { stopStreamingIfNeeded: vi.fn(), disposeConversation: vi.fn() },
        checkpoints: { disposeConversation: vi.fn() },
        requestChains: { invalidateConversation: vi.fn() },
        events: {},
        post: vi.fn(),
      } as unknown as ConversationTabsDeps);
      return { tabs, sidebar: () => sidebar };
    }

    it('when it is closed', async () => {
      const empty = conversation('empty', 'Untitled chat');
      const other = conversation('other');
      const { tabs } = tabsOver([empty, other]);
      link(empty, sessionLink('claude', sessionId));

      await tabs.close(empty.id);

      expect(findBySession(sessionId)).toBeUndefined();
    });

    it('when the user switches away from it, keeping it linked until an explicit close', async () => {
      const empty = conversation('empty', 'Untitled chat');
      const other = conversation('other');
      const { tabs, sidebar } = tabsOver([empty, other]);
      link(empty, sessionLink('claude', sessionId));

      tabs.switch(other.id);

      expect(sidebar().conversations.map((chat) => chat.id)).toEqual(['empty', 'other']);
      expect(findBySession(sessionId)).toBe('empty');

      await tabs.close(empty.id);

      expect(sidebar().conversations.map((chat) => chat.id)).toEqual(['other']);
      expect(findBySession(sessionId)).toBeUndefined();
    });

    it('but an archived chat keeps it', async () => {
      const used: ConversationRuntime = {
        ...conversation('used', 'Used chat'),
        messages: [{ role: 'user', content: 'push main' }],
      };
      const other = conversation('other');
      const { tabs, sidebar } = tabsOver([used, other]);
      link(used, sessionLink('claude', sessionId));

      await tabs.close(used.id);

      expect(sidebar().history.map((chat) => chat.id)).toEqual(['used']);
      expect(findBySession(sessionId)).toBe('used');
    });
  });

  it('validates agent kind and session id shapes', () => {
    const chat = conversation('chat');
    rebuildIndex([]);
    expect(() => link(chat, { ...sessionLink('claude', 'not-a-uuid') })).toThrow();
    expect(() => link(chat, { ...sessionLink('copilot', 'bad session id') })).toThrow();
  });

  it('persists and restores links through history files, then removes them with a deleted chat', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-links-'));
    try {
      const archiveFile = path.join(directory, HISTORY_ARCHIVE_FILE);
      const archive = new HistoryArchive(archiveFile);
      const stored: ConversationRuntime = {
        ...conversation('linked-chat', 'Linked chat'),
        agentLinks: {
          claude: sessionLink('claude', '00000000-0000-4000-8000-000000000003'),
        },
      };
      const sidebar: SidebarRuntime = {
        activeConversationId: 'active',
        conversations: [conversation('active')],
        history: [stored],
      };
      const store: Record<string, unknown> = {};
      saveSidebarSession(memento(store), sidebar, archive);
      await settle();

      const reloadedArchive = new HistoryArchive(archiveFile);
      const restored = loadSidebarSession(memento(store), reloadedArchive);
      expect(restored.history[0]?.agentLinks).toEqual(stored.agentLinks);
      expect(persistedToRuntime(runtimeToPersisted(restored).history![0]!).agentLinks).toEqual(
        stored.agentLinks,
      );

      restored.history = [];
      forgetConversation('linked-chat');
      saveSidebarSession(memento(store), restored, reloadedArchive);
      await settle();
      expect(new HistoryArchive(archiveFile).load()).toEqual([]);
      expect(fs.existsSync(path.join(directory, 'history', 'linked-chat.json'))).toBe(false);
      const other = conversation('other', 'Other chat');
      expect(() => link(other, stored.agentLinks!.claude!)).not.toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
