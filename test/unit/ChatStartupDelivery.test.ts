import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/sidebar/SessionLogger', () => ({
  SessionLogger: vi.fn().mockImplementation(function () {
    return {
      flush: vi.fn(),
      updateTitle: vi.fn(),
      logTurnError: vi.fn(),
      logTurnEnd: vi.fn(),
      logTurnStopped: vi.fn(),
    };
  }),
}));
import { createSidebarPromptRouter } from '../../src/sidebar/backgroundExitNotice';
import { SendPipeline, type SendPipelineDeps } from '../../src/sidebar/SendPipeline';
import { runCloudProviderTurn, runLocalProviderTurn, type ProviderTurnContext } from '../../src/sidebar/ProviderTurn';
import * as cloudResolver from '../../src/llm/CloudRequestResolver';
import { TurnLifecycle } from '../../src/sidebar/TurnLifecycle';
import { RequestChainLifecycle } from '../../src/sidebar/RequestChainLifecycle';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { CloudRequestTarget } from '../../src/llm/CloudRequestResolver';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';
import type { UserPromptOptions } from '../../src/sidebar/transcriptMutations';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { BackendTurnLease } from '../../src/backend/poolTypes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(busy = false, provider: ModelConfig['provider'] = 'llama.cpp') {
  const conv = {
    id: 'target',
    title: 'Maya',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as ConversationRuntime;
  const model = { name: 'maya', provider } as ModelConfig;
  const posted: HostToWebview[] = [];
  const startup = deferred<BackendTurnLease>();
  const response = deferred<{
    finalText: string;
    finishReason: string;
    rounds: number;
    repeatedCall: boolean;
    hitRoundCap: boolean;
  }>();
  const ctrl = new AbortController();
  const lifecycle = new TurnLifecycle();
  lifecycle.register(conv.id, ctrl);
  const post = (msg: HostToWebview) => posted.push({ ...msg, conversationId: conv.id });
  const context: ProviderTurnContext = {
    pool: { acquireForTurn: () => startup.promise } as unknown as ProviderTurnContext['pool'],
    lifecycle,
    checkpoints: {
      beginTurn: () => ({}),
      commitTurn: () => {},
      depth: () => 0,
    } as unknown as ProviderTurnContext['checkpoints'],
    events: {},
    emitAgentProgress: () => {},
    commitUserPrompt: vi.fn(),
    runModelTurn: () => response.promise,
  };
  const inbox = new MidTurnInbox();
  const runTurn = vi.fn(
    (
      _conv: ConversationRuntime,
      turnModel: ModelConfig,
      text: string,
      _attachments: unknown,
      promptOptions?: UserPromptOptions,
    ) => {
      const request = {
        conv,
        model: turnModel,
        text,
        attachments: undefined,
        promptOptions,
        activeFile: undefined,
        ctrl,
        postC: post,
      };
      return turnModel.provider === 'llama.cpp'
        ? runLocalProviderTurn(context, request)
        : runCloudProviderTurn(context, request);
    },
  );
  const pipeline = new SendPipeline({
    getConfig: () => ({ active_model: model.name, models: [model] }) as ForgeConfig,
    getSidebar: () =>
      ({ activeConversationId: 'visible', conversations: [conv] }) as unknown as SidebarRuntime,
    getActive: () => conv,
    agentLoop: {
      isStreamingConv: () => false,
      isCancellationPending: () => false,
      waitForCancelledTurns: async () => {},
      runTurn,
    } as unknown as SendPipelineDeps['agentLoop'],
    requestChains: new RequestChainLifecycle(),
    events: {},
    post,
    persistSession: () => {},
    postSessionSync: () => {},
    evaluateAfterTurn: async () => undefined,
    resetContextWarning: () => {},
    midTurnInbox: inbox,
  });
  let sent: ReturnType<SendPipeline['send']> | undefined;
  const router = createSidebarPromptRouter({
    activeId: () => 'visible',
    isReserved: () => busy,
    isOpen: () => true,
    addTell: (id, text, internal, tellId, createdAt, origin) =>
      inbox.add(id, { id: tellId ?? 'tell', text, internal, createdAt, origin }),
    removeTell: () => false,
    markSendNow: () => false,
    isStreaming: () => false,
    interruptForSteering: async () => {},
    send: (text, attachments, id, echoPrompt, internal, createdAt, onAdmitted, origin) => {
      sent = pipeline.send(
        text,
        attachments,
        id,
        { internal, origin },
        { echoPrompt, createdAt, onAdmitted },
      );
      return sent;
    },
  });
  return {
    router,
    pipeline,
    startup,
    response,
    ctrl,
    context,
    posted,
    inbox,
    runTurn,
    sent: () => sent,
  };
}

describe('chat message startup', () => {
  it('does not put a refused cloud agent prompt into a composer', async () => {
    const h = harness();
    const resolve = vi.spyOn(cloudResolver, 'resolveCloudRequestTarget').mockRejectedValue(new Error('cloud setup refused'));
    try {
      const result = await runCloudProviderTurn(h.context, {
        conv: { id: 'target' } as ConversationRuntime,
        model: { name: 'cloud', provider: 'openai' } as ModelConfig,
        text: 'agent note', attachments: undefined, activeFile: undefined,
        ctrl: h.ctrl, postC: msg => h.posted.push(msg), promptOptions: { origin: { kind: 'chat' } },
      });
      expect(result).toMatchObject({ kind: 'failed', error: 'cloud setup refused' });
      expect(h.posted.some(msg => msg.type === 'setInput')).toBe(false);
    } finally { resolve.mockRestore(); h.router.dispose(); }
  });
  it('propagates refusal without restoring an agent message to any composer', async () => {
    const h = harness();
    try {
      const delivery = h.router.deliverChatMessage('agent note', 'target');
      await tick();
      h.startup.reject(new Error('Loading Maya would interrupt Strata'));
      expect(await delivery).toEqual({
        kind: 'refused',
        error: expect.stringContaining('interrupt Strata'),
      });
      await h.sent();
      expect(h.posted.some((msg) => msg.type === 'setInput')).toBe(false);
      expect(h.posted).toContainEqual(
        expect.objectContaining({
          type: 'backendDown',
          conversationId: 'target',
          message: expect.stringContaining('interrupt Strata'),
        }),
      );
    } finally {
      h.router.dispose();
    }
  });

  it('acknowledges readiness after startup without waiting for the response', async () => {
    const h = harness();
    try {
      let acknowledged = false;
      const delivery = h.router.deliverChatMessage('agent note', 'target').then((result) => {
        acknowledged = true;
        return result;
      });
      await tick();
      expect(acknowledged).toBe(false);
      h.startup.resolve({ backend: {}, release: async () => {} } as BackendTurnLease);
      await tick();
      expect(acknowledged).toBe(true);
      expect(h.context.commitUserPrompt).toHaveBeenCalled();
      h.response.resolve({
        finalText: 'answer',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      });
      expect(await delivery).toEqual({ kind: 'turn' });
      await h.sent();
    } finally {
      h.router.dispose();
    }
  });

  it('does not acknowledge a turn cancelled during startup', async () => {
    const h = harness();
    try {
      const delivery = h.router.deliverChatMessage('agent note', 'target');
      await tick();
      h.ctrl.abort();
      h.startup.resolve({ backend: {}, release: async () => {} } as BackendTurnLease);
      expect(await delivery).toEqual({
        kind: 'refused',
        error: expect.stringContaining('cancelled'),
      });
      expect(h.context.commitUserPrompt).not.toHaveBeenCalled();
      expect(h.posted.some((msg) => msg.type === 'setInput')).toBe(false);
    } finally {
      h.router.dispose();
    }
  });

  it('does not commit or acknowledge cloud startup that resolves after cancellation', async () => {
    const h = harness(false, 'openai');
    const startup = deferred<CloudRequestTarget>();
    const resolve = vi
      .spyOn(cloudResolver, 'resolveCloudRequestTarget')
      .mockReturnValue(startup.promise);
    try {
      const delivery = h.router.deliverChatMessage('agent note', 'target');
      await tick();
      h.ctrl.abort();
      startup.resolve({ baseUrl: 'https://example.invalid', apiKey: 'key' });
      h.response.resolve({
        finalText: 'answer',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      });
      expect(await delivery).toEqual({
        kind: 'refused',
        error: expect.stringContaining('cancelled'),
      });
      expect(h.context.commitUserPrompt).not.toHaveBeenCalled();
      expect(h.posted.some((msg) => msg.type === 'setInput')).toBe(false);
    } finally {
      resolve.mockRestore();
      h.router.dispose();
    }
  });

  it('acknowledges cloud readiness after prompt commit and before the response', async () => {
    const h = harness(false, 'openai');
    const startup = deferred<CloudRequestTarget>();
    const resolve = vi
      .spyOn(cloudResolver, 'resolveCloudRequestTarget')
      .mockReturnValue(startup.promise);
    try {
      let acknowledged = false;
      const delivery = h.router.deliverChatMessage('agent note', 'target').then((result) => {
        acknowledged = true;
        return result;
      });
      await tick();
      expect(acknowledged).toBe(false);
      startup.resolve({ baseUrl: 'https://example.invalid', apiKey: 'key' });
      await tick();
      expect(acknowledged).toBe(true);
      expect(h.context.commitUserPrompt).toHaveBeenCalled();
      h.response.resolve({
        finalText: 'answer',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      });
      expect(await delivery).toEqual({ kind: 'turn' });
      await h.sent();
    } finally {
      resolve.mockRestore();
      h.router.dispose();
    }
  });

  it('reports a busy-chat queue without claiming that it was processed', async () => {
    const h = harness(true);
    try {
      expect(await h.router.deliverChatMessage('agent note', 'target')).toEqual({ kind: 'tell' });
      expect(h.runTurn).not.toHaveBeenCalled();
      expect(h.inbox.takeUndelivered('target')).toMatchObject([
        { text: 'agent note', origin: { kind: 'chat' } },
      ]);
    } finally {
      h.router.dispose();
    }
  });

  it('still returns a genuine user prompt on startup refusal', async () => {
    const h = harness();
    const sent = h.pipeline.send('user words', undefined, 'target');
    await tick();
    h.startup.reject(new Error('model busy'));
    await sent;
    expect(h.posted).toContainEqual({
      type: 'setInput',
      text: 'user words',
      conversationId: 'target',
    });
    h.router.dispose();
  });
});
