import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';

const { prepareCliChatAgent, runCliChat, runWarmCliChat } = vi.hoisted(() => ({
  prepareCliChatAgent: vi.fn(),
  runCliChat: vi.fn(),
  runWarmCliChat: vi.fn(),
}));

vi.mock('../../src/agents/CliChatRunner', () => ({
  prepareCliChatAgent,
  runCliChat,
  runWarmCliChat,
}));

import { runCliTurn, type CliTurnContext } from '../../src/sidebar/CliTurn';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { PLAN_UNCHANGED_NOTE, renderPlan } from '../../src/tools/planTools';

describe('CLI turn plan context', () => {
  beforeEach(() => {
    prepareCliChatAgent.mockReset().mockResolvedValue({ cliName: 'codex', executable: 'codex' });
    runCliChat.mockReset().mockResolvedValue({
      status: 'completed',
      finalText: 'Done.',
      assistantText: 'Done.',
    });
  });

  it('passes the full current plan to the CLI path, never the unchanged-plan marker', async () => {
    let cliMessages: ChatMessage[] = [];
    runCliChat.mockImplementation(async (options: { messages: ChatMessage[] }) => {
      cliMessages = options.messages;
      return { status: 'completed', finalText: 'Done.', assistantText: 'Done.' };
    });
    const items = [{ text: 'finish the active task', status: 'active' as const }];
    const conv = {
      id: 'cli-plan',
      title: 'CLI plan',
      createdAt: 0,
      updatedAt: 0,
      messages: [{ role: 'user', content: 'continue' }],
      plan: { items, updatedAt: 1 },
    } as ConversationRuntime;
    const lifecycle = {
      register: vi.fn(),
      markStreaming: vi.fn(),
      clearStreaming: vi.fn(),
      settle: vi.fn(),
      terminationKind: vi.fn(),
    };
    const checkpoints = {
      beginTurn: vi.fn(() => ({})),
      depth: vi.fn(() => 0),
      commitTurn: vi.fn(),
    };
    const context = {
      workspaceRoot: '/repo',
      lifecycle,
      checkpoints,
      events: {},
      cliSessions: {},
      cliDriver: {},
      commitUserPrompt: vi.fn(),
      onTranscriptChanged: vi.fn(),
      emitAgentProgress: vi.fn(),
    } as unknown as CliTurnContext;

    await runCliTurn(
      context,
      conv,
      { name: 'codex', provider: 'cli', cli: 'codex' } as never,
      'continue',
      undefined,
      vi.fn(),
    );

    const modelText = cliMessages.map((message) => String(message.content)).join('\n');
    expect(modelText).toContain(renderPlan(items));
    expect(modelText).not.toContain(PLAN_UNCHANGED_NOTE);
  });

  it('omits a finished plan from CLI messages and the warm resume task', async () => {
    let cliMessages: ChatMessage[] = [];
    let planPrompt: string | undefined;
    runWarmCliChat.mockReset().mockImplementation(
      async (options: { messages: ChatMessage[]; planPrompt?: string }) => {
        cliMessages = options.messages;
        planPrompt = options.planPrompt;
        return { status: 'completed', finalText: 'Done.', assistantText: 'Done.' };
      },
    );
    const items = [{ text: 'finish the archived work', status: 'done' as const }];
    const conv = {
      id: 'cli-finished-plan',
      title: 'CLI finished plan',
      createdAt: 0,
      updatedAt: 0,
      messages: [{ role: 'user', content: 'continue with new work' }],
      plan: { items, updatedAt: 1 },
      cli_sessions: { codex: 'warm-session' },
    } as ConversationRuntime;
    const lifecycle = {
      register: vi.fn(),
      markStreaming: vi.fn(),
      clearStreaming: vi.fn(),
      settle: vi.fn(),
      terminationKind: vi.fn(),
    };
    const checkpoints = {
      beginTurn: vi.fn(() => ({})),
      depth: vi.fn(() => 0),
      commitTurn: vi.fn(),
    };
    const context = {
      workspaceRoot: '/repo',
      lifecycle,
      checkpoints,
      events: {},
      cliSessions: {},
      cliDriver: undefined,
      commitUserPrompt: vi.fn(),
      onTranscriptChanged: vi.fn(),
      emitAgentProgress: vi.fn(),
    } as unknown as CliTurnContext;

    await runCliTurn(
      context,
      conv,
      { name: 'codex', provider: 'cli', cli: 'codex' } as never,
      'continue with new work',
      undefined,
      vi.fn(),
    );

    const modelText = cliMessages.map((message) => String(message.content)).join('\n');
    const cliRunner = await vi.importActual<typeof import('../../src/agents/CliChatRunner')>(
      '../../src/agents/CliChatRunner',
    );
    const resumeTask = cliRunner.buildCliResumeTask(cliMessages, planPrompt);
    expect(modelText).not.toContain(renderPlan(items));
    expect(planPrompt).toBeUndefined();
    expect(resumeTask).not.toContain(renderPlan(items));
  });
});
