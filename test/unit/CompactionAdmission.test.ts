import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sidebar/SessionLogger', () => ({
  SessionLogger: vi.fn().mockImplementation(function SessionLoggerMock() {
    return {
      flush: vi.fn(),
      updateTitle: vi.fn(),
      logTurnError: vi.fn(),
      logTurnStopped: vi.fn(),
    };
  }),
}));

import { SendPipeline, type SendPipelineDeps } from '../../src/sidebar/SendPipeline';
import { ContextBudgetPublisher } from '../../src/sidebar/ContextBudgetPublisher';
import type { ForgeConfig } from '../../src/config/types';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';
import { RequestChainLifecycle } from '../../src/sidebar/RequestChainLifecycle';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';

function conv(): ConversationRuntime {
  return {
    id: 'conv-1',
    title: 'Tab',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    active_model: null,
  } as ConversationRuntime;
}

function pipeline(turn: Record<string, unknown>) {
  const c = conv();
  const order: string[] = [];
  const config = { active_model: 'qwen', models: [{ name: 'qwen' }] } as ForgeConfig;
  const deps: SendPipelineDeps = {
    getConfig: () => config,
    getSidebar: () => ({ activeConversationId: c.id, conversations: [c] }) as SidebarRuntime,
    getActive: () => c,
    agentLoop: {
      isStreamingConv: () => false,
      isCancellationPending: () => false,
      waitForCancelledTurns: async () => undefined,
      runTurn: vi.fn(async () => {
        order.push('turn');
        return turn;
      }),
    } as unknown as SendPipelineDeps['agentLoop'],
    requestChains: new RequestChainLifecycle(),
    events: { onBackendError: vi.fn() },
    post: vi.fn(),
    persistSession: vi.fn(),
    postSessionSync: vi.fn(),
    evaluateAfterTurn: vi.fn(async () => undefined),
    evaluateAtAdmission: vi.fn(async () => {
      order.push('admission');
    }),
    resetContextWarning: vi.fn(),
    midTurnInbox: new MidTurnInbox(),
  };
  return { send: new SendPipeline(deps), deps, order };
}

describe('admission compaction (A47)', () => {
  it.each([
    ['completed', { kind: 'completed', finalText: 'ok', finishReason: 'stop' }],
    ['cancelled', { kind: 'cancelled', finalText: '' }],
    ['interrupted', { kind: 'interrupted', finalText: 'partial' }],
  ])('runs once, before the turn, for a send after a %s turn', async (_name, turn) => {
    const h = pipeline(turn);
    await h.send.send('next request');
    expect(h.deps.evaluateAtAdmission).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(['admission', 'turn']);
  });

  it('does not run for internal continuations', async () => {
    const h = pipeline({ kind: 'completed', finalText: 'ok', finishReason: 'stop' });
    await h.send.send('resume', undefined, undefined, { internal: true });
    expect(h.deps.evaluateAtAdmission).not.toHaveBeenCalled();
  });

  it('a failing admission check does not block the prompt', async () => {
    const h = pipeline({ kind: 'completed', finalText: 'ok', finishReason: 'stop' });
    vi.mocked(h.deps.evaluateAtAdmission!).mockRejectedValueOnce(new Error('boom'));
    await h.send.send('next request');
    expect(h.order).toEqual(['turn']);
  });
});

describe('ContextBudgetPublisher.evaluateAtAdmission', () => {
  function publisher(used: number, enabled: boolean) {
    const c = conv();
    c.last_input_tokens = used;
    const admissionCompact = vi.fn(async () => 'compacted');
    const config = {
      active_model: 'qwen',
      models: [{ name: 'qwen', num_ctx: 100_000 }],
      auto_compact: { enabled },
    } as unknown as ForgeConfig;
    const p = new ContextBudgetPublisher({
      getConfig: () => config,
      getSidebar: () => ({ activeConversationId: c.id, conversations: [c] }) as SidebarRuntime,
      post: vi.fn(),
      baseOf: (id) => id ?? null,
      autoCompact: vi.fn(),
      manualCompact: vi.fn(),
      admissionCompact,
    });
    return { p, c, admissionCompact };
  }

  it('compacts at or above the configured threshold', async () => {
    const h = publisher(90_000, true);
    await h.p.evaluateAtAdmission(h.c);
    expect(h.admissionCompact).toHaveBeenCalledTimes(1);
  });

  it('does nothing below the threshold or when auto-compact is off', async () => {
    const low = publisher(10_000, true);
    await low.p.evaluateAtAdmission(low.c);
    const off = publisher(95_000, false);
    await off.p.evaluateAtAdmission(off.c);
    expect(low.admissionCompact).not.toHaveBeenCalled();
    expect(off.admissionCompact).not.toHaveBeenCalled();
  });
});
