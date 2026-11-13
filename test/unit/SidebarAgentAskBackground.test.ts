import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskAgentRunResult, AskAgentRuntime } from '../../src/agentLinks/askAgentService';
import { isAskAgentRunning } from '../../src/agentLinks/askAgentService';
import { agentTargetCatalog } from '../../src/agentLinks/agentTargets';
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
const waitForRun = (signal: AbortSignal) =>
  vi.waitFor(() => expect(runs.some((run) => run.signal === signal)).toBe(true));
const runFor = (signal: AbortSignal) => runs.find((run) => run.signal === signal)!;

describe('ask_agent background asks', () => {
  it('keeps an accepted queued selection across rediscovery and suppresses its semantic duplicate', async () => {
    const { asker } = setup();
    await asker.start(chatId, { agent: 'codex', message: 'Long first task' });
    const target = {
      agent: 'codex' as const,
      kind: 'new_task' as const,
      cwd: 'C:/repo',
      title: 'Runtime',
      model: 'runtime-model',
      effort: 'high',
    };
    const [first] = agentTargetCatalog.publish(chatId, 'C:/repo', [target]);
    await asker.start(chatId, { agent: 'codex', message: 'Review', targetId: first!.targetId });
    const selected = pendingAgentAsksFor(chatId)[1]!;
    const [rediscovered] = agentTargetCatalog.publish(chatId, 'C:/repo', [target]);
    const duplicate = await asker.start(chatId, {
      agent: 'codex',
      message: 'Review',
      targetId: rediscovered!.targetId,
    });
    expect(duplicate).toContain('nothing new was sent');
    expect(pendingAgentAsksFor(chatId)).toHaveLength(2);
    runs[0]!.settle({ status: 'completed', finalText: 'First done' });
    await waitForRun(selected.controller.signal);
    expect(runtime.runHeadless).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'runtime-model', effort: 'high', startNew: true }),
    );
    asker.cancel(chatId);
  });
  it('queues identical briefs for different selected targets instead of suppressing one', async () => {
    const { asker } = setup();
    const targets = agentTargetCatalog.publish(
      chatId,
      'C:/repo',
      ['first-model', 'second-model'].map((model) => ({
        agent: 'codex' as const,
        kind: 'new_task' as const,
        cwd: 'C:/repo',
        title: model,
        model,
        effort: 'high',
      })),
    );
    await asker.start(chatId, {
      agent: 'codex',
      message: 'Review',
      targetId: targets[0]!.targetId,
    });
    const second = await asker.start(chatId, {
      agent: 'codex',
      message: 'Review',
      targetId: targets[1]!.targetId,
    });
    expect(second).toContain('it starts when exchange');
    expect(pendingAgentAsksFor(chatId)).toHaveLength(2);
    expect(pendingAgentAsksFor(chatId)[1]!.request.targetId).toBe(targets[1]!.targetId);
    asker.cancel(chatId);
  });
  beforeEach(async () => {
    for (const run of runs.splice(0)) run.settle({ status: 'cancelled', finalText: '' });
    await flush();
    vi.mocked(runtime.runHeadless).mockClear();
  });

  afterEach(async () => {
    for (const entry of pendingAgentAsksFor(chatId)) entry.controller.abort();
    for (const run of runs.splice(0)) run.settle({ status: 'cancelled', finalText: '' });
    for (let i = 0; i < 4; i += 1) await flush();
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
    // No live link here, so the heading says a new background session answered.
    expect(deliver.mock.calls[0]![0]).toBe(
      `**Claude replied** (ask_agent exchange ${exchange}: Review the plan; ` +
        'a new background Claude session answered, not a session the owner has open)\n\nLooks right.',
    );
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

  it('queues a different ask, refuses its repeat, and runs another agent at once', async () => {
    const { asker } = setup();
    const first = await asker.start(chatId, { agent: 'claude', message: 'one' });
    const firstId = /exchange ([0-9a-f]{8})/u.exec(first)?.[1];
    const queued = await asker.start(chatId, { agent: 'claude', message: 'two' });
    const queuedId = /exchange ([0-9a-f]{8})/u.exec(queued)?.[1];
    expect(queued).toBe(
      `Asked Claude (exchange ${queuedId}); it starts when exchange ${firstId} finishes. Its reply will arrive as a message in this chat; carry on with the rest of the task.`,
    );
    const again = await asker.start(chatId, { agent: 'claude', message: 'two' });
    expect(again).toBe(
      `Claude is still working on exchange ${queuedId} (asked under a minute ago); nothing new was sent. Its reply will arrive as a message: do not ask again. Carry on, or end your turn if you cannot continue without it.`,
    );
    await vi.waitFor(() => expect(runs.filter((run) => run.agent === 'claude')).toHaveLength(1));
    const codex = await asker.start(chatId, { agent: 'codex', message: 'three' });
    expect(codex).toMatch(/^Asked Codex/u);
    await vi.waitFor(() => expect(runs.filter((run) => run.agent === 'codex')).toHaveLength(1));
    for (const run of runs) run.settle({ status: 'completed', finalText: 'done' });
    await flush();
  });

  it('starts queued asks only after the previous ask settles and delivers replies in order', async () => {
    const { asker, deliver } = setup();
    await asker.start(chatId, { agent: 'claude', message: 'one' });
    const firstSignal = pendingAgentAsksFor(chatId)[0]!.controller.signal;
    await asker.start(chatId, { agent: 'claude', message: 'two' });
    await waitForRun(firstSignal);
    expect(runs.filter((run) => run.signal === firstSignal)).toHaveLength(1);
    runFor(firstSignal).settle({ status: 'completed', finalText: 'first reply' });
    await flush();
    const secondSignal = pendingAgentAsksFor(chatId)[0]!.controller.signal;
    await waitForRun(secondSignal);
    expect(
      runs.filter((run) => run.signal === firstSignal || run.signal === secondSignal),
    ).toHaveLength(2);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toContain('first reply');
    runFor(secondSignal).settle({ status: 'completed', finalText: 'second reply' });
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]![0]).toContain('second reply');
  });

  it('refuses trimmed duplicate questions without queueing them', async () => {
    const { asker } = setup();
    await asker.start(chatId, { agent: 'claude', message: ' one ' });
    const signal = pendingAgentAsksFor(chatId)[0]!.controller.signal;
    const duplicate = await asker.start(chatId, { agent: 'claude', message: 'one' });
    expect(duplicate).toBe(
      'Claude is still working on exchange ' +
        `${pendingAgentAsksFor(chatId)[0]!.exchangeId} (asked under a minute ago); nothing new was sent. ` +
        'Its reply will arrive as a message: do not ask again. Carry on, or end your turn if you cannot continue without it.',
    );
    expect(pendingAgentAsksFor(chatId)).toHaveLength(1);
    await waitForRun(signal);
    expect(runs.filter((run) => run.signal === signal)).toHaveLength(1);
    runFor(signal).settle({ status: 'completed', finalText: 'done' });
    await flush();
  });

  it('cancel aborts every pending exchange of the chat and delivers nothing', async () => {
    const { asker, deliver } = setup();
    await asker.start(chatId, { agent: 'claude', message: 'one' });
    await asker.start(chatId, { agent: 'claude', message: 'two' });
    const signals = pendingAgentAsksFor(chatId).map((entry) => entry.controller.signal);
    asker.cancel(chatId);
    await flush();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(runs.filter((run) => run.signal === signals[0])).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(pendingAgentAsksFor(chatId)).toEqual([]);
    expect(isAskAgentRunning(chatId)).toBe(false);
  });

  it('lists running and queued exchanges in the end-of-turn notice', async () => {
    const { asker } = setup();
    await asker.start(chatId, { agent: 'claude', message: 'one' });
    const running = pendingAgentAsksFor(chatId)[0]!;
    await asker.start(chatId, { agent: 'claude', message: 'two' });
    const queued = pendingAgentAsksFor(chatId)[1]!;
    expect(pendingAgentAsksNotice(chatId, running.startedAt)).toBe(
      `Waiting on Claude (exchange ${running.exchangeId}, under a minute); its reply will start a new turn.\n` +
        `Waiting on Claude (exchange ${queued.exchangeId}, queued after ${running.exchangeId}); its reply will start a new turn.`,
    );
  });

  it('reports a queued exchange as running once it starts', async () => {
    const { asker } = setup();
    await asker.start(chatId, { agent: 'claude', message: 'one' });
    const firstSignal = pendingAgentAsksFor(chatId)[0]!.controller.signal;
    await asker.start(chatId, { agent: 'claude', message: 'two' });
    const queued = pendingAgentAsksFor(chatId)[1]!;
    await waitForRun(firstSignal);
    runFor(firstSignal).settle({ status: 'completed', finalText: 'first' });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(pendingAgentAsksNotice(chatId, queued.startedAt)).toBe(
      `Waiting on Claude (exchange ${queued.exchangeId}, under a minute); its reply will start a new turn.`,
    );
  });

  it('delivers a queued refusal as a reply when it never starts', async () => {
    const config = { agent_bus: { enabled: true } } as ForgeConfig;
    const { asker, deliver } = setup(config);
    await asker.start(chatId, { agent: 'claude', message: 'one' });
    const firstSignal = pendingAgentAsksFor(chatId)[0]!.controller.signal;
    await asker.start(chatId, { agent: 'claude', message: 'two' });
    config.agent_bus = { enabled: false };
    await waitForRun(firstSignal);
    runFor(firstSignal).settle({ status: 'completed', finalText: 'first' });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(runs.filter((run) => run.signal === firstSignal)).toHaveLength(1);
    expect(deliver.mock.calls[1]![0]).toContain('ask_agent is disabled');
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
