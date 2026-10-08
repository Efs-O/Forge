import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
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
import { getLogger } from '../../src/util/logger';

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

  it('links, unlinks, and rebuilds the reverse index', () => {
    const first = conversation('first');
    const second = conversation('second');
    const claude = sessionLink('claude', '00000000-0000-4000-8000-000000000001');
    rebuildIndex([]);

    link(first, claude, [first, second]);
    expect(unlink(first, 'claude')).toEqual(claude);
    link(second, claude, [first, second]);
    expect(() => link(first, claude, [first, second])).toThrow('second');

    rebuildIndex([first, second]);
    expect(() => link(first, claude, [first, second])).toThrow('second');
  });

  it('refuses one session being linked to another chat and names the existing chat', () => {
    const first = conversation('first', 'First chat');
    const second = conversation('second', 'Second chat');
    const codex = sessionLink('codex', '00000000-0000-4000-8000-000000000002');
    rebuildIndex([]);
    link(first, codex, [first, second]);

    expect(() => link(second, codex, [first, second])).toThrow('First chat');
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
      expect(() => link(other, archived.agentLinks!.codex!, [other])).toThrow('Archived chat');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports duplicate sessions and keeps the newest link during activation', () => {
    const first: ConversationRuntime = {
      ...conversation('first', 'Older chat'),
      agentLinks: {
        claude: {
          ...sessionLink('claude', '00000000-0000-4000-8000-000000000005'),
          lastUsedAt: 10,
        },
      },
    };
    const second: ConversationRuntime = {
      ...conversation('second', 'Newer chat'),
      agentLinks: {
        claude: {
          ...sessionLink('claude', '00000000-0000-4000-8000-000000000005'),
          lastUsedAt: 20,
        },
      },
    };
    const error = vi.spyOn(getLogger(), 'error');
    const warnings: string[] = [];
    const state: SidebarRuntime = {
      activeConversationId: first.id,
      conversations: [first, second],
      history: [],
    };

    expect(() =>
      loadSidebarSession(
        memento({ [SESSION_KEY_V1]: runtimeToPersisted(state) }),
        undefined,
        (message) => warnings.push(message),
      ),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('keeping "Newer chat"'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Older chat');
    expect(warnings[0]).toContain('Newer chat');
    expect(warnings[0]).toContain('keeping it with "Newer chat"');
    expect(() => link(first, first.agentLinks!.claude!, [first, second])).toThrow('Newer chat');
    error.mockRestore();
  });

  it('/clearChat keeps links and a newly created conversation starts without them', () => {
    const active = conversation('active', 'Active chat');
    link(active, sessionLink('copilot', 'copilot-session-1'), [active]);
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
    } as unknown as ConversationTabsDeps);

    tabs.clearActive();
    expect(sidebar.conversations[0]?.agentLinks).toEqual(linksBeforeClear);
    const created = tabs.create();
    expect(created?.agentLinks).toBeUndefined();
  });

  it('validates agent kind and session id shapes', () => {
    const chat = conversation('chat');
    rebuildIndex([]);
    expect(() => link(chat, { ...sessionLink('claude', 'not-a-uuid') }, [chat])).toThrow();
    expect(() => link(chat, { ...sessionLink('copilot', 'bad session id') }, [chat])).toThrow();
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
      expect(() => link(other, stored.agentLinks!.claude!, [other])).not.toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
