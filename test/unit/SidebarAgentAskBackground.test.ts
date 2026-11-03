import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskAgentRunResult, AskAgentRuntime } from '../../src/agentLinks/askAgentService';
import { isAskAgentRunning } from '../../src/agentLinks/askAgentService';
import {
  BACKGROUND_ASK_LIMIT_MS,
  pendingAgentAsksFor,
  pendingAgentAsksNotice,
} from '../../src/agentLinks/pendingAgentAsks';
import { rebuildIndex, type AgentKind, type AgentLink } from '../../src/agentLinks/chatAgentLinks';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { ForgeConfig } from '../../src/config/types';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';
import { runningBackgroundExecutionsNotice } from '../../src/sidebar/backgroundExitNotice';

interface PendingRun {
  agent: AgentKind;
  signal: AbortSignal;
  settle(result: AskAgentRunResult): void;
  fail(error: Error): void;
}

const runs: PendingRun[] = [];
const runtime: AskAgentRuntime = {
  openPanel: vi.fn(async () => 'unavailable' as const),
  isLive: vi.fn(async () => false),
  sendLive: vi.fn(async () => ({ status: 'failed' as const, finalText: '' })),
  runHeadless: vi.fn(
    (request: { agent: AgentKind; signal: AbortSignal }) =>
      new Promise<AskAgentRunResult>((resolve, reject) => {
        const run: PendingRun = {
          agent: request.agent,
          signal: request.signal,
          settle: resolve,
          fail: reject,
        };
        request.signal.addEventListener('abort', () =>
          resolve({ status: 'cancelled', finalText: '' }),
        );
        runs.push(run);
      }),
  ) as unknown as AskAgentRuntime['runHeadless'],
};

const runtimeOptions: Array<{ waitLimitMs?: number }> = [];
vi.mock('../../src/agentLinks/askAgentRuntime', () => ({
  makeAskAgentRuntime: (options: { waitLimitMs?: number }) => {
    runtimeOptions.push(options);
    return runtime;
  },
}));

const { createSidebarAgentAsk } = await import('../../src/sidebar/sidebarAgentAsk');

const chatId = '5b0d9a62-8f5a-4d55-9c1e-1f0f6c1f4a11';

function link(kind: AgentKind): AgentLink {
  return {
    kind,
    sessionId:
      kind === 'claude'
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
    cwd: 'C:/repo',
    title: `Forge · ${kind}`,
    linkedAt: 1,
    lastUsedAt: 1,
    origin: 'forge-created',
  };
}

function setup(config: Partial<ForgeConfig> = { agent_bus: { enabled: true } } as ForgeConfig) {
  const conv: ConversationRuntime = {
    id: chatId,
    title: 'Design chat',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    agentLinks: { claude: link('claude'), codex: link('codex') },
  };
  rebuildIndex([conv]);
  const sidebar: SidebarRuntime = {
    activeConversationId: chatId,
    conversations: [conv],
    history: [],
  };
  const checkpoints = {
    beginTurn: vi.fn((turnId: string) => ({ turnId })),
    commitTurn: vi.fn(),
  };
  const deliver = vi.fn(async () => ({ kind: 'turn' as const }));
  const onPendingChanged = vi.fn();
  const asker = createSidebarAgentAsk({
    getConfig: () => ({ ...config, agent_links: { open_panel: 'never' } }) as ForgeConfig,
    getSidebar: () => sidebar,
    checkpoints: checkpoints as unknown as CheckpointStack,
    workspaceRoot: 'C:/repo',
    persist: vi.fn(),
    onPendingChanged,
    deliver,
  });
  return { asker, sidebar, checkpoints, deliver, onPendingChanged };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ask_agent background asks', () => {
  beforeEach(async () => {
    for (const run of runs.splice(0)) run.settle({ status: 'cancelled', finalText: '' });
    await flush();
    vi.mocked(runtime.runHeadless).mockClear();
  });

  it('returns at once with an exchange id and delivers the reply once', async () => {
    const { asker, deliver, checkpoints, onPendingChanged } = setup();
    const text = await asker.start(chatId, { agent: 'claude', message: 'Review the plan' });
    const exchange = /exchange ([0-9a-f]{8})/u.exec(text)?.[1];
    expect(text).toMatch(/^Asked Claude \(exchange [0-9a-f]{8}\)\. Its reply will arrive/u);
    expect(isAskAgentRunning(chatId)).toBe(true);
    expect(pendingAgentAsksNotice(chatId)).toContain(`exchange ${exchange}`);
    expect(onPendingChanged).toHaveBeenCalledWith(chatId);
    expect(
      runningBackgroundExecutionsNotice(chatId, Date.now(), {
        listRunningForConversation: () => [],
      }),
    ).toContain('Waiting on Claude');
    expect(checkpoints.beginTurn).toHaveBeenCalledWith(`agent-ask-${exchange}`, chatId);
    expect(deliver).not.toHaveBeenCalled();

    runs[0]!.settle({ status: 'completed', finalText: 'Looks right.' });
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![1]).toBe(chatId);
    expect(deliver.mock.calls[0]![0]).toMatch(
      new RegExp(
        `^\\*\\*Claude replied\\*\\* \\(ask_agent exchange ${exchange}: Review the plan\\)`,
        'u',
      ),
    );
    expect(deliver.mock.calls[0]![0]).toContain('Looks right.');
    expect(checkpoints.commitTurn).toHaveBeenCalledTimes(1);
    expect(isAskAgentRunning(chatId)).toBe(false);
    expect(pendingAgentAsksFor(chatId)).toEqual([]);
    expect(onPendingChanged).toHaveBeenLastCalledWith(chatId);
    expect(onPendingChanged).toHaveBeenCalledTimes(2);
  });

  it('gives the background ask a 30-minute limit and leaves the remote ask on the defaults', () => {
    runtimeOptions.length = 0;
    setup();
    expect(BACKGROUND_ASK_LIMIT_MS).toBe(30 * 60_000);
    expect(runtimeOptions.map((options) => options.waitLimitMs)).toEqual([
      undefined,
      BACKGROUND_ASK_LIMIT_MS,
    ]);
  });

  it('refuses a second ask to the same agent but runs another agent', async () => {
    const { asker } = setup();
    const first = await asker.start(chatId, { agent: 'claude', message: 'one' });
    const exchange = /exchange ([0-9a-f]{8})/u.exec(first)?.[1];
    const again = await asker.start(chatId, { agent: 'claude', message: 'two' });
    expect(again).toContain(`Claude is still working on exchange ${exchange}`);
    expect(again).not.toMatch(/^Error:/u);
    expect(runtime.runHeadless).toHaveBeenCalledTimes(1);
    const codex = await asker.start(chatId, { agent: 'codex', message: 'three' });
    expect(codex).toMatch(/^Asked Codex/u);
    expect(runtime.runHeadless).toHaveBeenCalledTimes(2);
  });

  it('cancel aborts every pending exchange of the chat and delivers nothing', async () => {
    const { asker, deliver } = setup();
    await asker.start(chatId, { agent: 'claude', message: 'one' });
    await asker.start(chatId, { agent: 'codex', message: 'two' });
    asker.cancel(chatId);
    await flush();
    expect(runs.map((run) => run.signal.aborted)).toEqual([true, true]);
    expect(deliver).not.toHaveBeenCalled();
    expect(pendingAgentAsksFor(chatId)).toEqual([]);
    expect(isAskAgentRunning(chatId)).toBe(false);
  });

  it('delivers a failure, and a runtime that throws, as a reply that did not come', async () => {
    const { asker, deliver } = setup();
    await asker.start(chatId, { agent: 'claude', message: 'one' });
    runs[0]!.settle({ status: 'timed_out', finalText: '', error: 'timed out after 10 min' });
    await flush();
    await asker.start(chatId, { agent: 'codex', message: 'two' });
    runs[1]!.fail(new Error('spawn failed'));
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]![0]).toMatch(/^\*\*Claude did not reply\*\*/u);
    expect(deliver.mock.calls[0]![0]).toContain('timed out after 10 min');
    expect(deliver.mock.calls[1]![0]).toContain('spawn failed');
    expect(isAskAgentRunning(chatId)).toBe(false);
    expect(pendingAgentAsksFor(chatId)).toEqual([]);
  });

  it('returns a refusal as the tool result without starting anything', async () => {
    const { asker, deliver, checkpoints } = setup({ agent_bus: { enabled: false } } as ForgeConfig);
    const text = await asker.start(chatId, { agent: 'claude', message: 'one' });
    expect(text).toMatch(/^Error: Claude could not answer: ask_agent is disabled/u);
    await flush();
    expect(runtime.runHeadless).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(checkpoints.commitTurn).toHaveBeenCalledTimes(1);
    expect(pendingAgentAsksFor(chatId)).toEqual([]);
  });

  it('drops the reply of a chat that is no longer open', async () => {
    const { asker, deliver, sidebar } = setup();
    await asker.start(chatId, { agent: 'claude', message: 'one' });
    sidebar.history = sidebar.conversations.splice(0);
    runs[0]!.settle({ status: 'completed', finalText: 'late' });
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(pendingAgentAsksFor(chatId)).toEqual([]);
  });
});
