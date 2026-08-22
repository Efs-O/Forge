import { describe, expect, it, vi } from 'vitest';
import { SlashCommandHandler, type SlashCommandDeps } from '../../src/sidebar/SlashCommandHandler';
import type { ForgeConfig } from '../../src/config/types';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

describe('SlashCommandHandler', () => {
  it('resumes the same conversation after a manual compact', async () => {
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
      persistSession: () => undefined,
      postSessionSync: () => undefined,
      invalidateExactTokenBudget: () => undefined,
      postTokenBudget: () => undefined,
      post: () => undefined,
      // Long enough to clear runCompaction's plausibility floor, which now
      // rejects a short candidate as an unusable summary.
      runPromptToMarkdown: async () => 'Goal: continue the second task. State: the first task is done and the second is in progress. Next: finish it. Files: src/a.ts, src/b.ts. Constraints: none recorded. Errors: none. This body exists only to clear the plausibility floor that rejects tool-call-shaped summaries.',
      isStreaming: () => false,
      beginCompaction: () => () => undefined,
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

    expect(resumeAfterManualCompact).toHaveBeenCalledWith('conversation-1');
  });
});
