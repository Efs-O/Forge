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
import { rebuildIndex } from '../../src/agentLinks/chatAgentLinks';
import { loadConfig } from '../../src/config/ConfigLoader';

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
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn() })),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
}));

describe('SlashCommandHandler', () => {
  it('offers /strataMode choices and reports its write to the active chat', async () => {
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
      } as unknown as SlashCommandDeps).handle('strataMode');

      expect(isLoaded).toHaveBeenCalledWith('strata');
      expect(loadConfig(directory).models[0]?.start_command?.[3]).toBe('pair');
      expect(post).toHaveBeenCalledWith({
        type: 'notice',
        message: expect.stringContaining('1 chat currently running.'),
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
