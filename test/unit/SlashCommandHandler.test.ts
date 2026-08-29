import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { SlashCommandHandler, type SlashCommandDeps } from '../../src/sidebar/SlashCommandHandler';
import type { ForgeConfig } from '../../src/config/types';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

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
}));

describe('SlashCommandHandler', () => {
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
        'Goal: continue the second task. State: the first task is done and the second is in progress. Next: finish it. Files: src/a.ts, src/b.ts. Constraints: none recorded. Errors: none. This body exists only to clear the plausibility floor that rejects tool-call-shaped summaries.',
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
        'Goal: retain the completed task. State: all requested work is finished. Next: wait for the user. Files: src/a.ts, src/b.ts. Constraints: none recorded. Errors: none. This body exists only to clear the plausibility floor that rejects tool-call-shaped summaries.',
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
