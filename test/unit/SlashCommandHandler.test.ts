import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SlashCommandHandler, type SlashCommandDeps } from '../../src/sidebar/SlashCommandHandler';
import type { HostActivityEvent } from '../../src/sidebar/HostActivity';
import type { ForgeConfig } from '../../src/config/types';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { chatsForSession, rebuildIndex } from '../../src/agentLinks/chatAgentLinks';
import type { ClaudeSession } from '../../src/agentBus/claudePeer';
import type { DiscoveredThread } from '../../src/agentMesh/codexDiscovery';
import { sameFolder } from '../../src/sidebar/linkAgentPicker';
import { loadConfig } from '../../src/config/ConfigLoader';
import {
  hasConversationReadSecret,
  markConversationReadSecret,
} from '../../src/tools/exfilTaint';
import {
  approvedHostsFor,
  clearConversationHostApprovals,
  markHostApproved,
} from '../../src/tools/fetchHostApprovals';

const CHECKIN_FIXTURE = `# Keep this hand-written comment.
active_model: gemma-a
llama_server:
  binary: /path/to/llama-server
models:
  # Primary model comment survives.
  - name: gemma-a
    gguf_path: /models/gemma-a.gguf
other_setting: preserved
`;

const STRATA_FIXTURE = `active_model: strata
llama_server:
  binary: /path/to/llama-server
models:
  - name: strata
    model: strata
    provider: openai-compatible
    endpoint: http://localhost:3333/v1
    unload_path: /unload
    start_command: [python, start_strata.py, --mode, solo]
`;

vi.mock('vscode', () => ({
  window: {
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    // `ConfigLoader.warnOnce` toasts the phase-2 warning about models that still
    // name their own server programs, which this fixture does have.
    showWarningMessage: vi.fn(),
    // The Codex session list spawns a throwaway app-server, so the picker
    // shows its wait in the window status bar; the fake runs the task at once.
    withProgress: vi.fn((_options: unknown, task: () => Promise<unknown>) => task()),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn() })),
  },
  ProgressLocation: { Window: 1 },
  commands: {
    executeCommand: vi.fn(),
  },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
}));

describe('SlashCommandHandler', () => {
  it('offers two chat-mode choices with the current mode checked and reports its write', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-strata-slash-'));
    const configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, STRATA_FIXTURE, 'utf8');
    const post = vi.fn();
    const isLoaded = vi.fn(() => true);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'multi',
      choice: 'multi',
      description: 'Allow two chats at once.',
    });
    try {
      await new SlashCommandHandler({
        getConfigPath: () => configPath,
        getConfig: () => ({ active_model: 'strata' }) as ForgeConfig,
        getActiveConv: () => ({ id: 'chat-1', active_model: 'strata' }) as ConversationRuntime,
        getConversations: () => [{ id: 'chat-1' }, { id: 'chat-2' }] as ConversationRuntime[],
        isStreamingConv: (conversationId) => conversationId === 'chat-2',
        pool: { isLoaded } as unknown as IBackendPool,
        post,
      } as unknown as SlashCommandDeps).handle('chatMode');

      expect(isLoaded).toHaveBeenCalledWith('strata');
      expect(loadConfig(directory).models[0]?.start_command?.[3]).toBe('multi');
      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        [
          { label: '$(check) solo', choice: 'solo', description: 'One chat at a time.' },
          {
            label: 'multi',
            choice: 'multi',
            description: 'Two chats at once. A lone chat ~10-20% slower.',
          },
        ],
        { title: 'Chat mode: strata (now solo)' },
      );
      expect(post).toHaveBeenCalledWith({
        type: 'notice',
        message: expect.stringContaining('Chat mode set to multi'),
        conversationId: 'chat-1',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('posts a refusal without opening the picker', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chat-mode-refusal-'));
    const configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, STRATA_FIXTURE.replace('solo]', 'pair]'), 'utf8');
    const post = vi.fn();
    vi.mocked(vscode.window.showQuickPick).mockClear();
    try {
      await new SlashCommandHandler({
        getConfigPath: () => configPath,
        getConfig: () => ({ active_model: 'strata' }) as ForgeConfig,
        getActiveConv: () => ({ id: 'chat-1', active_model: 'strata' }) as ConversationRuntime,
        getConversations: () => [{ id: 'chat-1' }] as ConversationRuntime[],
        isStreamingConv: () => false,
        pool: { isLoaded: vi.fn(() => false) } as unknown as IBackendPool,
        post,
      } as unknown as SlashCommandDeps).handle('chatMode');

      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({
        type: 'notice',
        message: 'Forge: strata start_command[3] is "pair"; set it to solo or multi.',
        conversationId: 'chat-1',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('sets the check-in reminder through the config writer and confirms in chat', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-checkin-'));
    const configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, CHECKIN_FIXTURE, 'utf8');
    const post = vi.fn();
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async (options) => {
      expect(options?.value).toBe('off');
      expect(options?.validateInput?.('20')).toBeUndefined();
      return '20';
    });
    try {
      await new SlashCommandHandler({
        getConfigPath: () => configPath,
        getConfig: () => ({}) as ForgeConfig,
        getActiveConv: () => ({ id: 'chat-1' }) as ConversationRuntime,
        post,
      } as unknown as SlashCommandDeps).handle('checkin');

      expect(loadConfig(directory).elapsed_time_note?.after_minutes).toBe(20);
      const raw = fs.readFileSync(configPath, 'utf8');
      expect(raw).toContain('# Keep this hand-written comment.');
      expect(raw).toContain('# Primary model comment survives.');
      expect(raw).toContain('other_setting: preserved');
      expect(post).toHaveBeenCalledWith({
        type: 'notice',
        message: 'Check-in reminder: after 20 minutes',
        conversationId: 'chat-1',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('off removes the elapsed-time block while preserving other config and comments', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-checkin-'));
    const configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, `${CHECKIN_FIXTURE}elapsed_time_note:\n  after_minutes: 60\n`, 'utf8');
    const post = vi.fn();
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('off');
    try {
      await new SlashCommandHandler({
        getConfigPath: () => configPath,
        getConfig: () => ({ elapsed_time_note: { after_minutes: 60 } }) as ForgeConfig,
        getActiveConv: () => ({ id: 'chat-1' }) as ConversationRuntime,
        post,
      } as unknown as SlashCommandDeps).handle('checkin');

      const raw = fs.readFileSync(configPath, 'utf8');
      expect(raw).not.toContain('elapsed_time_note');
      expect(raw).toContain('# Primary model comment survives.');
      expect(raw).toContain('other_setting: preserved');
      expect(loadConfig(directory).elapsed_time_note).toBeUndefined();
      expect(post).toHaveBeenCalledWith(expect.objectContaining({
        type: 'notice',
        message: 'Check-in reminder: off',
      }));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an out-of-range check-in value without changing the config', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-checkin-'));
    const configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, CHECKIN_FIXTURE, 'utf8');
    const before = fs.readFileSync(configPath, 'utf8');
    let validation: string | undefined;
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async (options) => {
      validation = options?.validateInput?.('4');
      return undefined;
    });
    try {
      await new SlashCommandHandler({
        getConfigPath: () => configPath,
        getConfig: () => ({}) as ForgeConfig,
      } as unknown as SlashCommandDeps).handle('checkin');

      expect(validation).toMatch(/5 to 240/u);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ['config', 'forge.openConfig'],
    ['logs', 'forge.showBackendConsole'],
  ] as const)('routes /%s through the existing command', async (id, command) => {
    await new SlashCommandHandler({} as unknown as SlashCommandDeps).handle(id);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(command);
  });

  it('routes the selected /context option through the existing context command', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'Selection',
      description: 'Use the current editor selection as context.',
      command: 'forge.useSelection',
    });

    await new SlashCommandHandler({} as unknown as SlashCommandDeps).handle('context');

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('forge.useSelection');
  });

  it('renames the active conversation and persists the normalized title', async () => {
    const conversation: ConversationRuntime = {
      id: 'conversation-1',
      title: 'Chat',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
    };
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('  shared   runtime test  ');
    const persistSession = vi.fn();
    const postSessionSync = vi.fn();
    const deps = {
      getActiveConv: () => conversation,
      getConversation: (conversationId: string) =>
        conversationId === conversation.id ? conversation : undefined,
      persistSession,
      postSessionSync,
    } as unknown as SlashCommandDeps;

    await new SlashCommandHandler(deps).handle('rename');

    expect(conversation.title).toBe('shared runtime test');
    expect(conversation.updatedAt).toBeGreaterThan(0);
    expect(persistSession).toHaveBeenCalledOnce();
    expect(postSessionSync).toHaveBeenCalledOnce();
  });

  it('leaves the conversation unchanged when renaming is cancelled', async () => {
    const conversation: ConversationRuntime = {
      id: 'conversation-1',
      title: 'Existing title',
      createdAt: 0,
      updatedAt: 10,
      messages: [],
    };
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
    const persistSession = vi.fn();
    const deps = {
      getActiveConv: () => conversation,
      getConversation: (conversationId: string) =>
        conversationId === conversation.id ? conversation : undefined,
      persistSession,
      postSessionSync: vi.fn(),
    } as unknown as SlashCommandDeps;

    await new SlashCommandHandler(deps).handle('rename');

    expect(conversation).toMatchObject({ title: 'Existing title', updatedAt: 10 });
    expect(persistSession).not.toHaveBeenCalled();
  });

  it('links and unlinks a validated user-selected session from the active chat', async () => {
    rebuildIndex([]);
    const conversation: ConversationRuntime = {
      id: 'conversation-link',
      title: 'Link test',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
    };
    const persistSession = vi.fn();
    const postSessionSync = vi.fn();
    const deps = {
      getActiveConv: () => conversation,
      getConversations: () => [conversation],
      persistSession,
      postSessionSync,
      post: vi.fn(),
    } as unknown as SlashCommandDeps;
    const handler = new SlashCommandHandler(deps);

    await handler.handle('linkAgent', {
      agentKind: 'claude',
      sessionId: '00000000-0000-4000-8000-000000000004',
    });

    expect(conversation.agentLinks?.claude).toMatchObject({
      sessionId: '00000000-0000-4000-8000-000000000004',
      origin: 'user-set',
      cwd: '/workspace',
    });
    expect(persistSession).toHaveBeenCalledOnce();
    expect(postSessionSync).toHaveBeenCalledOnce();

    await handler.handle('unlinkAgent', { agentKind: 'claude' });
    expect(conversation.agentLinks).toBeUndefined();
    expect(persistSession).toHaveBeenCalledTimes(2);
    expect(postSessionSync).toHaveBeenCalledTimes(2);
  });

  // A "model unloaded" line is transient status, not a record: the flag is
  // what makes the transport delete it after the command-reply delay.
  it.each([
    ['unloadModel', 'Forge: qwen unloaded.'],
    ['unloadAll', 'Forge: all models unloaded.'],
  ] as const)(
    'marks the /%s broadcast ephemeral so the transport deletes it',
    async (commandId, text) => {
      const emitted: HostActivityEvent[] = [];
      const deps = {
        unloadActiveModel: vi.fn(async () => ({ model: 'qwen', wasLoaded: true })),
        unloadModels: vi.fn(async () => undefined),
        post: vi.fn(),
      } as unknown as SlashCommandDeps;
      const handler = new SlashCommandHandler(deps);
      handler.onHostActivity((event) => emitted.push(event));

      await handler.handle(commandId);

      expect(emitted).toEqual([{ text, ephemeral: true }]);
      if (commandId === 'unloadModel') {
        expect(deps.unloadActiveModel).toHaveBeenCalledOnce();
        expect(deps.unloadModels).not.toHaveBeenCalled();
      } else {
        expect(deps.unloadModels).toHaveBeenCalledOnce();
        expect(deps.unloadActiveModel).not.toHaveBeenCalled();
      }
    },
  );

  it('reports a stopped configured server after /unload', async () => {
    const emitted: HostActivityEvent[] = [];
    const deps = {
      unloadActiveModel: vi.fn(async () => ({
        model: 'strata',
        wasLoaded: true,
        serverStopped: true,
      })),
      post: vi.fn(),
    } as unknown as SlashCommandDeps;
    const handler = new SlashCommandHandler(deps);
    handler.onHostActivity((event) => emitted.push(event));

    await handler.handle('unloadModel');

    expect(emitted).toEqual([{ text: 'Forge: strata unloaded; server stopped.', ephemeral: true }]);
  });

  it('leaves other window-scoped broadcasts non-ephemeral', async () => {
    const emitted: HostActivityEvent[] = [];
    const deps = {
      newConversation: vi.fn(async () => undefined),
    } as unknown as SlashCommandDeps;
    const handler = new SlashCommandHandler(deps);
    handler.onHostActivity((event) => emitted.push(event));

    await handler.handle('newChat');

    expect(emitted).toEqual([{ text: 'Forge: started a new chat in this window.' }]);
  });

  it('resumes the same conversation after compacting an interrupted turn', async () => {
    const conversation: ConversationRuntime = {
      id: 'conversation-1',
      title: 'test',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'completed first task' },
        { role: 'user', content: 'second task' },
      ],
    };
    const resumeAfterManualCompact = vi.fn(async () => undefined);
    const deps = {
      getActiveConv: () => conversation,
      getConversation: (conversationId: string) =>
        conversationId === conversation.id ? conversation : undefined,
      persistSession: () => undefined,
      postSessionSync: () => undefined,
      invalidateExactTokenBudget: () => undefined,
      postTokenBudget: () => undefined,
      post: () => undefined,
      // Long enough to clear runCompaction's plausibility floor, which now
      // rejects a short candidate as an unusable summary.
      runPromptToMarkdown: async () =>
        'Goal: continue the second task.\nState: the first task is done and the second is in progress.\nNext: finish it.\nFiles: src/a.ts, src/b.ts.\nConstraints: none recorded.\nErrors: none.\nReference: none recorded. This body exists only to clear the plausibility floor that rejects tool-call-shaped summaries.',
      currentLocalTime: () => 'test local time',
      isStreaming: () => false,
      beginCompaction: () => () => undefined,
      incompleteTurnReason: () => 'the reply was cut off by the output limit',
      resumeAfterManualCompact,
      getConfig: () => ({}) as ForgeConfig,
      pool: {} as IBackendPool,
      events: {},
      reindexCodebase: async () => undefined,
      newConversation: async () => undefined,
      clearMessages: () => undefined,
      submitPrompt: async () => undefined,
      undo: async () => [],
      keep: async () => undefined,
      toggleClanker: () => false,
    } as unknown as SlashCommandDeps;

    await new SlashCommandHandler(deps).handle('compact');

    expect(resumeAfterManualCompact).toHaveBeenCalledWith(
      'conversation-1',
      'the reply was cut off by the output limit',
    );
  });

  it('leaves an idle conversation asleep after a manual compact', async () => {
    const conversation: ConversationRuntime = {
      id: 'conversation-1',
      title: 'test',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'completed first task' },
        { role: 'user', content: 'second task' },
      ],
    };
    const resumeAfterManualCompact = vi.fn(async () => undefined);
    const deps = {
      getActiveConv: () => conversation,
      getConversation: (conversationId: string) =>
        conversationId === conversation.id ? conversation : undefined,
      persistSession: () => undefined,
      postSessionSync: () => undefined,
      invalidateExactTokenBudget: () => undefined,
      postTokenBudget: () => undefined,
      post: () => undefined,
      runPromptToMarkdown: async () =>
        'Goal: retain the completed task.\nState: all requested work is finished.\nNext: wait for the user.\nFiles: src/a.ts, src/b.ts.\nConstraints: none recorded.\nErrors: none.\nReference: none recorded. This body exists only to clear the plausibility floor that rejects tool-call-shaped summaries.',
      currentLocalTime: () => 'test local time',
      isStreaming: () => false,
      beginCompaction: () => () => undefined,
      incompleteTurnReason: () => undefined,
      resumeAfterManualCompact,
      getConfig: () => ({}) as ForgeConfig,
      pool: {} as IBackendPool,
      events: {},
      reindexCodebase: async () => undefined,
      newConversation: async () => undefined,
      clearMessages: () => undefined,
      submitPrompt: async () => undefined,
      undo: async () => [],
      keep: async () => undefined,
      toggleClanker: () => false,
    } as unknown as SlashCommandDeps;

    await new SlashCommandHandler(deps).handle('compact');

    expect(conversation.compaction).toBeDefined();
    expect(resumeAfterManualCompact).not.toHaveBeenCalled();
  });
});

// The header's 🔗 button and `/link` used to ask for a raw session id: "if I
// want to link it to a Claude session I have to somehow find the
// 329402309fhksk… number" (owner, 2026-10-27). Now the kind's own list is
// shown — Claude Code's registry of live sessions, or the Codex daemon's thread
// list — and the raw-id box survives as the last item.
describe('linking an agent session from a list', () => {
  const CLAUDE_NEW = '11111111-1111-4111-8111-111111111111';
  const CLAUDE_OLD = '22222222-2222-4222-8222-222222222222';
  const CLAUDE_SDK = '33333333-3333-4333-8333-333333333333';
  const CLAUDE_ELSEWHERE = '44444444-4444-4444-8444-444444444444';
  const CODEX_A = '55555555-5555-4555-8555-555555555555';
  const CODEX_ELSEWHERE = '66666666-6666-4666-8666-666666666666';
  const BY_HAND = 'Enter a session ID by hand…';

  function claudeRow(
    pid: number,
    sessionId: string,
    name: string,
    cwd: string,
    sdk: boolean,
    startedAt: number,
  ): ClaudeSession {
    return {
      pid,
      sessionId,
      name,
      cwd,
      status: 'idle',
      sdk,
      pipe: undefined,
      peerProtocol: 1,
      startedAt,
    };
  }

  /** The window as the button sees it: this chat plus one other chat that
   *  already holds `CLAUDE_OLD`, and listers in place of a real registry or
   *  daemon (no CLI is spawned in these tests). */
  function linkHarness(sessions: readonly ClaudeSession[], codexThreads: () => Promise<DiscoveredThread[]> = async () => []) {
    const conversation: ConversationRuntime = {
      id: 'chat-1',
      title: 'This chat',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
    };
    const otherChat: ConversationRuntime = {
      id: 'chat-2',
      title: 'Other chat',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
      agentLinks: {
        claude: {
          kind: 'claude',
          sessionId: CLAUDE_OLD,
          cwd: '/workspace',
          title: 'old chat',
          linkedAt: 1,
          lastUsedAt: 1,
          origin: 'user-set',
        },
      },
    };
    rebuildIndex([conversation, otherChat]);
    const persistSession = vi.fn();
    const postSessionSync = vi.fn();
    const post = vi.fn();
    const deps = {
      getActiveConv: () => conversation,
      getConversations: () => [conversation, otherChat],
      getConfig: () => ({}) as ForgeConfig,
      persistSession,
      postSessionSync,
      post,
      agentSessionListers: { claude: () => [...sessions], codex: codexThreads },
    } as unknown as SlashCommandDeps;
    return { conversation, deps, persistSession, postSessionSync, post };
  }

  /** Capture what each QuickPick was offered, and pick the first real session. */
  function recordPicks(captured: { items: unknown[]; options?: unknown }[][]): unknown {
    return async (items: unknown, options?: unknown) => {
      const list = items as { sessionId?: string }[];
      captured.push({ items: list as unknown[], options });
      return (list.find((item) => item.sessionId) ??
        (list[list.length - 1] as vscode.QuickPickItem)) as vscode.QuickPickItem;
    };
  }

  it('lists this folder\'s running Claude sessions by name, newest first, and stores the name', async () => {
    const now = Date.now();
    const captured: { items: unknown[]; options?: unknown }[] = [];
    const harness = linkHarness([
      claudeRow(11, CLAUDE_OLD, 'old chat', '/workspace', false, now - 3 * 60 * 60_000),
      claudeRow(12, CLAUDE_NEW, 'review the patch', '/workspace', false, now - 5 * 60_000),
      claudeRow(13, CLAUDE_SDK, 'sdk run', '/workspace', true, now),
      claudeRow(14, CLAUDE_ELSEWHERE, 'elsewhere', '/other-folder', false, now),
    ]);
    vi.mocked(vscode.window.showQuickPick)
      .mockReset()
      .mockImplementationOnce(async (items) => {
        captured.push({ items: items as unknown[] });
        return 'claude' as never;
      })
      .mockImplementationOnce(recordPicks(captured) as never);
    await new SlashCommandHandler(harness.deps).handle('linkAgent');

    expect(captured[0]!.items).toEqual(['claude', 'codex', 'copilot']);
    const rows = captured[1]!.items as { label: string; description?: string; detail?: string }[];
    // Newest first; the `sdk` launch and the session started in another folder
    // are not offered, and the raw-id box is always the last item.
    expect(rows.map((row) => row.label)).toEqual(['review the patch', 'old chat', BY_HAND]);
    expect(String(rows[0]!.description)).toContain('running · started 5 min ago');
    expect(String(rows[0]!.detail)).toContain(CLAUDE_NEW);
    // The header strip then reads like the rows Forge creates itself.
    expect(harness.conversation.agentLinks?.claude).toMatchObject({
      sessionId: CLAUDE_NEW,
      title: 'review the patch',
      origin: 'user-set',
      cwd: '/workspace',
    });
    expect(harness.persistSession).toHaveBeenCalledOnce();
    expect(harness.postSessionSync).toHaveBeenCalledOnce();
  });

  it('says which chat already holds a session, and links this chat beside it', async () => {
    const captured: { items: unknown[]; options?: unknown }[] = [];
    const now = Date.now();
    const harness = linkHarness([
      claudeRow(11, CLAUDE_OLD, 'old chat', '/workspace', false, now - 60_000),
    ]);
    vi.mocked(vscode.window.showQuickPick)
      .mockReset()
      .mockImplementationOnce(async (items) => {
        captured.push({ items: items as unknown[] });
        return 'claude' as never;
      })
      .mockImplementationOnce(async (items) => {
        const list = items as { sessionId?: string }[];
        captured.push({ items: list as unknown[] });
        return list.find((item) => item.sessionId === CLAUDE_OLD) as vscode.QuickPickItem;
      });
    await new SlashCommandHandler(harness.deps).handle('linkAgent');

    const row = (captured[1]!.items as { detail?: string }[])[0]!;
    expect(String(row.detail)).toContain('linked to chat "Other chat"');
    // Taking a session away from the chat that holds it is no longer a refusal:
    // both chats hold it now, so `--to` reaches either and `say` without `--to`
    // goes to whichever was addressed last (docs/plans/V1_FINISH_PLAN.md
    // lane 4 phase 5). The warning still has to be there, or the owner picks
    // blind.
    const postedErrors = harness.post.mock.calls.filter(
      ([message]) => (message as { type?: string })?.type === 'error',
    );
    expect(postedErrors).toEqual([]);
    expect(harness.conversation.agentLinks?.claude).toMatchObject({
      sessionId: CLAUDE_OLD,
      origin: 'user-set',
    });
    expect(chatsForSession(CLAUDE_OLD).sort()).toEqual(['chat-1', 'chat-2']);
  });

  it('lists Codex threads for the same folder, newest first, and stores the thread name', async () => {
    const captured: { items: unknown[]; options?: unknown }[] = [];
    const now = Date.now();
    const harness = linkHarness([], async () => [
      { id: CODEX_ELSEWHERE, cwd: '/other-folder', name: 'elsewhere', updatedAt: now },
      { id: CODEX_A, cwd: '/workspace', preview: 'fix the flaky test', updatedAt: now - 1000 },
    ]);
    vi.mocked(vscode.window.showQuickPick)
      .mockReset()
      .mockImplementationOnce(async (items) => {
        captured.push({ items: items as unknown[] });
        return 'codex' as never;
      })
      .mockImplementationOnce(recordPicks(captured) as never);
    await new SlashCommandHandler(harness.deps).handle('linkAgent');

    const rows = captured[1]!.items as { label: string; description?: string }[];
    expect(rows.map((row) => row.label)).toEqual(['fix the flaky test', BY_HAND]);
    expect(String(rows[0]!.description)).toContain('thread · updated');
    expect(harness.conversation.agentLinks?.codex).toMatchObject({
      sessionId: CODEX_A,
      title: 'fix the flaky test',
    });
    expect(vscode.window.withProgress).toHaveBeenCalled();
  });

  it('a Codex listing that fails says so in the picker and still links by hand', async () => {
    const captured: { items: unknown[]; options?: unknown }[] = [];
    const harness = linkHarness([], async () => {
      throw new Error('codex not installed');
    });
    vi.mocked(vscode.window.showQuickPick)
      .mockReset()
      .mockImplementationOnce(async (items) => {
        captured.push({ items: items as unknown[] });
        return 'codex' as never;
      })
      .mockImplementationOnce(async (items, options) => {
        captured.push({ items: items as unknown[], options });
        return (items as vscode.QuickPickItem[])[0]!;
      });
    vi.mocked(vscode.window.showInputBox)
      .mockReset()
      .mockResolvedValueOnce(CODEX_A);
    await new SlashCommandHandler(harness.deps).handle('linkAgent');

    const placeholder = (captured[1]!.options as { placeHolder: string }).placeHolder;
    expect(placeholder).toContain('Could not list Codex sessions: codex not installed');
    expect(captured[1]!.items.map((item) => (item as { label: string }).label)).toEqual([BY_HAND]);
    // The by-hand box is unchanged: it still validates the id for the kind.
    const box = vi.mocked(vscode.window.showInputBox).mock.calls[0]![0] as {
      title: string;
      validateInput: (value: string) => string | undefined;
    };
    expect(box.title).toBe('Link codex session');
    expect(box.validateInput('not-an-id')).toContain('Enter a valid codex session id.');
    expect(box.validateInput(CODEX_A)).toBeUndefined();
    expect(harness.conversation.agentLinks?.codex).toMatchObject({
      sessionId: CODEX_A,
      // No name came from the failed listing, so the id is the title, as before.
      title: CODEX_A,
    });
  });

  it('Copilot has no lister, so it goes straight to the box without a session picker', async () => {
    const harness = linkHarness([]);
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.window.showInputBox).mockReset().mockResolvedValueOnce(CODEX_A);
    await new SlashCommandHandler(harness.deps).handle('linkAgent', {
      agentKind: 'copilot',
    });
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(harness.conversation.agentLinks?.copilot).toMatchObject({ sessionId: CODEX_A });
  });

  it('a raw id typed as /link claude <id> is linked without being asked anything', async () => {
    const harness = linkHarness([claudeRow(12, CLAUDE_NEW, 'review', '/workspace', false, 1)]);
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.window.showInputBox).mockReset();
    await new SlashCommandHandler(harness.deps).handle('linkAgent', {
      agentKind: 'claude',
      sessionId: CLAUDE_NEW,
    });
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(harness.conversation.agentLinks?.claude).toMatchObject({
      sessionId: CLAUDE_NEW,
      title: CLAUDE_NEW,
    });
  });

  it('compares folders the way the platform does, not by string equality', () => {
    expect(
      sameFolder('N:\\vs code apps\\Forge', 'n:/vs code apps/Forge/', 'win32'),
    ).toBe(true);
    expect(sameFolder('n:/vs code apps/Forge', 'N:/VS CODE APPS/FORGE', 'win32')).toBe(true);
    expect(sameFolder('n:/vs code apps/Forge', 'N:/VS CODE APPS/FORGE', 'linux')).toBe(false);
    expect(sameFolder('/workspace', '/workspace/other', 'linux')).toBe(false);
    expect(sameFolder('', '/workspace', 'linux')).toBe(false);
  });
});

describe('/clearChat clears what belonged to the cleared chat', () => {
  // The "this chat has read a secret" flag is conversation-scoped like the
  // history. Left behind, it would gate the next fetch for a read the user can
  // no longer see in the transcript, and the agent could not explain why
  // (docs/plans/EXFIL_GATES_PLAN.md, State × lifecycle ledger).
  it('drops the secret-read flag with the history', async () => {
    markConversationReadSecret('chat-clear');
    const clearMessages = vi.fn();
    const deps = {
      getActiveConv: () => ({ id: 'chat-clear' }) as ConversationRuntime,
      clearMessages,
      post: () => undefined,
      events: {},
    } as unknown as SlashCommandDeps;
    await new SlashCommandHandler(deps).handle('clearChat');
    expect(clearMessages).toHaveBeenCalled();
    expect(hasConversationReadSecret('chat-clear')).toBe(false);
  });

  // `docs/plans/EXFIL_GATES_PLAN.md` acceptance 4 says `/clearChat` clears the
  // approved-host set as well: a cleared chat has to behave like a new chat, and
  // a new chat asks before it reaches a host the old one approved.
  it('drops the hosts it approved with the history, and only that chat', async () => {
    markHostApproved('chat-clear-2', 'collector.example.net');
    markHostApproved('chat-clear-3', 'collector.example.net');
    const deps = {
      getActiveConv: () => ({ id: 'chat-clear-2' }) as ConversationRuntime,
      clearMessages: vi.fn(),
      post: () => undefined,
      events: {},
    } as unknown as SlashCommandDeps;
    await new SlashCommandHandler(deps).handle('clearChat');
    expect(approvedHostsFor('chat-clear-2')).toEqual([]);
    // The other chat earned its own approval, so this chat has no right to lose
    // it for it.
    expect(approvedHostsFor('chat-clear-3')).toEqual(['collector.example.net']);
    clearConversationHostApprovals();
  });
});

describe('/approvals', () => {
  it('lists chat and host approvals, then resets both without changing Clanker', async () => {
    const conversation = {
      id: 'chat-approvals-command',
      title: 'Approvals',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      approval_rules: ['cross_chat'],
      clanker: true,
    } as ConversationRuntime;
    clearConversationHostApprovals(conversation.id);
    markHostApproved(conversation.id, 'docs.example.test');
    const post = vi.fn();
    const persistSession = vi.fn(async () => true);
    const handler = new SlashCommandHandler({
      getActiveConv: () => conversation,
      getConversations: () => [conversation],
      getConfig: () => ({}) as ForgeConfig,
      post,
      persistSession,
    } as unknown as SlashCommandDeps);

    await handler.handle('approvals');
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notice',
        conversationId: conversation.id,
        message: expect.stringContaining('messages to other chats  (cross_chat)'),
      }),
    );
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining('any request to docs.example.test  (net:docs.example.test)'),
    });

    await handler.handle('approvals', { approvalAction: 'reset' });
    expect(conversation.approval_rules).toEqual([]);
    expect(approvedHostsFor(conversation.id)).toEqual([]);
    expect(conversation.clanker).toBe(true);
    expect(persistSession).toHaveBeenCalledOnce();
    expect(post).toHaveBeenLastCalledWith({
      type: 'notice',
      message: 'Approvals reset for this chat. The next gated call asks again.',
      conversationId: conversation.id,
    });
    clearConversationHostApprovals(conversation.id);
  });
});
