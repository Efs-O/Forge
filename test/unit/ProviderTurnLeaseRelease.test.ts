/**
 * Regression tests for the leaked backend turn pin (bug hunt 2026-10-02, #1).
 *
 * Pressing Stop while a cold model is loading used to return from
 * `runLocalProviderTurn` without releasing the lease, so
 * `BackendPool.turnPins[key]` stayed at 1 for the life of the window. That
 * slot then stopped being an eviction candidate, and with
 * `max_simultaneous_models: 1` loading any other model failed with a message
 * blaming delegation, which was not involved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    createOutputChannel: () => ({
      appendLine: () => {},
      append: () => {},
      clear: () => {},
      show: () => {},
      dispose: () => {},
    }),
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

const harness = vi.hoisted(() => ({
  /** hotSwap deferrals, in spawn order — the test settles them by hand. */
  pending: [] as Array<{ resolve: () => void; reject: (err: unknown) => void }>,
  events: [] as string[],
}));

vi.mock('../../src/backend/DirectBackend', () => {
  class FakeDirectBackend {
    private ready = false;
    constructor(
      _config: unknown,
      private readonly port: number,
    ) {}
    hotSwap(): Promise<void> {
      harness.events.push(`hotSwap:${this.port}`);
      return new Promise<void>((resolve, reject) => {
        harness.pending.push({
          resolve: () => {
            this.ready = true;
            resolve();
          },
          reject,
        });
      });
    }
    async stop(): Promise<void> {
      this.ready = false;
      harness.events.push(`stop:${this.port}`);
    }
    isReady(): boolean {
      return this.ready;
    }
    baseUrl(): string {
      return `http://127.0.0.1:${this.port}`;
    }
    loadedModel(): string | null {
      return null;
    }
    applyForgeConfig(): void {}
    showConsole(): void {}
    async start(): Promise<void> {}
    onUnexpectedExit(_cb: () => void): void {}
  }
  return { DirectBackend: FakeDirectBackend };
});

import {
  runCloudProviderTurn,
  runLocalProviderTurn,
  type ProviderTurnContext,
} from '../../src/sidebar/ProviderTurn';
import { TurnLifecycle } from '../../src/sidebar/TurnLifecycle';
import { SystemPromptRenderError } from '../../src/llm/SystemPromptInjector';
import * as cloudRequestResolver from '../../src/llm/CloudRequestResolver';
import { BackendPool } from '../../src/backend/BackendPool';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

function makeConfig(maxModels: number): ForgeConfig {
  return {
    models: [
      { name: 'A', provider: 'llama.cpp', gguf_path: '/a.gguf' },
      { name: 'B', provider: 'llama.cpp', gguf_path: '/b.gguf' },
    ],
    active_model: 'A',
    llama_server: { port: 8080 },
    max_simultaneous_models: maxModels,
  } as ForgeConfig;
}

const turnPinsOf = (pool: BackendPool): Map<string, number> =>
  (pool as unknown as { turnPins: Map<string, number> }).turnPins;

/** Let every already-scheduled promise callback run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeConv(): ConversationRuntime {
  return { id: 'conv-1', updatedAt: Date.now() } as ConversationRuntime;
}

function fakeModel(name: string): ModelConfig {
  return { name, provider: 'llama.cpp', gguf_path: `/${name}.gguf` } as ModelConfig;
}

interface FakeTurnHarness {
  ctx: ProviderTurnContext;
  /** How many times the turn lease's release() ran. */
  releases: number;
  /** How many times the model turn itself was started. */
  modelTurnCalls: number;
  acquires: number;
}

/** A pool whose lease release is observable, with no real backend involved. */
function fakeHarness(pool: ProviderTurnContext['pool']): FakeTurnHarness {
  const state = { releases: 0, modelTurnCalls: 0 };
  const ctx: ProviderTurnContext = {
    pool,
    lifecycle: new TurnLifecycle(),
    checkpoints: {
      beginTurn: () => ({}),
      commitTurn: () => {},
      depth: () => 0,
    } as unknown as ProviderTurnContext['checkpoints'],
    events: {},
    emitAgentProgress: () => {},
    commitUserPrompt: () => {},
    runModelTurn: async () => {
      state.modelTurnCalls += 1;
      return {
        finalText: 'answer',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      };
    },
  };
  return {
    ctx,
    get releases() {
      return state.releases;
    },
    get modelTurnCalls() {
      return state.modelTurnCalls;
    },
    get acquires() {
      return (pool as unknown as { acquires?: number }).acquires ?? 0;
    },
  };
}

/** A pool fake whose acquireForTurn hands out a counting lease. */
function countingPool(order?: string[]): ProviderTurnContext['pool'] {
  const state = { releases: 0, acquires: 0 };
  const pool = {
    acquireForTurn: async () => {
      state.acquires += 1;
      let released = false;
      return {
        backend: {
          baseUrl: () => 'http://127.0.0.1:8080',
          isReady: () => true,
          loadedModel: () => 'A',
          showConsole: () => {},
          applyForgeConfig: () => {},
          dispose: async () => {},
        },
        // Mirrors `BackendPool.acquireForTurn`: release is idempotent via the
        // lease's own `released` flag, so the outer net calling it a second
        // time un-pins exactly once — which is what this counts.
        release: () => {
          if (released) return Promise.resolve();
          released = true;
          state.releases += 1;
          order?.push('release');
          return Promise.resolve();
        },
      };
    },
    acquire: async () => {
      throw new Error('acquire must not run when acquireForTurn exists');
    },
    isLoaded: () => true,
    loadedModelNames: () => ['A'],
  };
  return Object.defineProperties(pool, {
    releases: { get: () => state.releases },
    acquires: { get: () => state.acquires },
  }) as unknown as ProviderTurnContext['pool'];
}

function runTurn(
  ctx: ProviderTurnContext,
  ctrl: AbortController,
  postC: (message: HostToWebview) => void = () => {},
) {
  return runLocalProviderTurn(ctx, {
    conv: fakeConv(),
    model: fakeModel('A'),
    text: 'hello',
    attachments: undefined,
    activeFile: undefined,
    ctrl,
    postC,
  });
}

describe('runLocalProviderTurn turn-lease release', () => {
  beforeEach(() => {
    harness.pending.length = 0;
    harness.events.length = 0;
  });

  it('releases the lease when Stop lands during backend start', async () => {
    const pool = countingPool();
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);

    const turn = runTurn(h.ctx, ctrl);
    // Stop arrives while the backend is still being acquired.
    ctrl.abort();
    const outcome = await turn;

    expect(outcome.kind).toBe('cancelled');
    // The bug: this return path had no release at all, so the pin stayed.
    expect((pool as unknown as { releases: number }).releases).toBe(1);
    expect(h.modelTurnCalls).toBe(0);
  });

  it('releases the lease exactly once on the normal completed path', async () => {
    const pool = countingPool();
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);

    const outcome = await runTurn(h.ctx, ctrl);

    expect(outcome.kind).toBe('completed');
    expect((pool as unknown as { releases: number }).releases).toBe(1);
  });

  it('settles as failed when a local catch hook throws', async () => {
    const h = fakeHarness(countingPool());
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    const settle = vi.spyOn(h.ctx.lifecycle, 'settle');
    const finished = vi.fn();
    h.ctx.events.onBackendError = () => {
      throw new Error('backend error hook failed');
    };
    h.ctx.events.onGenerationFinished = finished;
    h.ctx.runModelTurn = async () => {
      throw new Error('model request failed');
    };

    await expect(runTurn(h.ctx, ctrl)).rejects.toThrow('backend error hook failed');

    expect(settle).toHaveBeenCalledWith('conv-1');
    expect(finished).toHaveBeenCalledWith('A', 'conv-1', '', 'failed');
  });

  it('releases capacity during a question wait and reacquires before continuation', async () => {
    const pool = countingPool();
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    const posted: HostToWebview[] = [];
    let resolveAnswer!: (answer: string) => void;
    let noteQuestionWaiting!: () => void;
    const questionWaiting = new Promise<void>((resolve) => (noteQuestionWaiting = resolve));
    h.ctx.runModelTurn = async (...args) => {
      const withQuestionWait = args[8];
      expect(withQuestionWait).toBeTypeOf('function');
      const answer = await withQuestionWait!(
        () =>
          new Promise<string>((resolve) => {
            resolveAnswer = resolve;
            noteQuestionWaiting();
          }),
      );
      expect(answer).toBe('answered');
      expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(true);
      expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual(['conv-1']);
      return {
        finalText: 'answer',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      };
    };

    const turn = runTurn(h.ctx, ctrl, (message) => posted.push(message));
    await questionWaiting;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(posted.some((message) => message.type === 'backendStarting')).toBe(false);
    expect((pool as unknown as { releases: number }).releases).toBe(1);
    expect(h.acquires).toBe(1);
    expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(true);
    expect([...h.ctx.lifecycle.streamingIds()]).toEqual(['conv-1']);
    expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual([]);
    resolveAnswer('answered');

    await expect(turn).resolves.toMatchObject({ kind: 'completed' });
    expect(h.acquires).toBe(2);
    expect((pool as unknown as { releases: number }).releases).toBe(2);
    expect(posted.some((message) => message.type === 'backendStarting')).toBe(false);
  });

  it('keeps an answer saved and waits visibly when the original model slot is occupied', async () => {
    const pool = countingPool();
    const acquire = pool.acquireForTurn!;
    let attempts = 0;
    let allowResume = false;
    let noteBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => (noteBlocked = resolve));
    Object.assign(pool, {
      acquireForTurn: async (...args: Parameters<typeof acquire>) => {
        attempts += 1;
        if (attempts > 1 && !allowResume) {
          if (attempts === 2) noteBlocked();
          throw new Error('no free slot and no eviction candidate');
        }
        return acquire(...args);
      },
    });
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    const posted: HostToWebview[] = [];
    let answerSaved = false;
    let continued = false;
    let answerValue: string | undefined;
    h.ctx.runModelTurn = async (...args) => {
      const withQuestionWait = args[8]!;
      answerValue = await withQuestionWait(async () => {
        answerSaved = true;
        return 'Q1 multi';
      });
      continued = true;
      return {
        finalText: 'answer',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      };
    };

    const turn = runTurn(h.ctx, ctrl, (message) => posted.push(message));
    await blocked;
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(answerSaved).toBe(true);
    expect(answerValue).toBeUndefined();
    expect(continued).toBe(false);
    expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(true);
    expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual([]);
    expect(
      posted.some(
        (message) =>
          message.type === 'backendStarting' && message.message.includes('your answer is saved'),
      ),
    ).toBe(true);

    allowResume = true;
    await expect(turn).resolves.toMatchObject({ kind: 'completed' });

    expect(answerValue).toBe('Q1 multi');
    expect(continued).toBe(true);
    expect(h.acquires).toBe(2);
    expect((pool as unknown as { releases: number }).releases).toBe(2);
    expect(posted.some((message) => message.type === 'ready')).toBe(true);
  });

  it('does not reacquire after Stop cancels a question wait', async () => {
    const pool = countingPool();
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    let noteQuestionWaiting!: () => void;
    const questionWaiting = new Promise<void>((resolve) => (noteQuestionWaiting = resolve));
    h.ctx.runModelTurn = async (...args) => {
      const withQuestionWait = args[8]!;
      await withQuestionWait(
        () =>
          new Promise<string>((resolve) => {
            ctrl.signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
            noteQuestionWaiting();
          }),
      );
      return {
        finalText: '',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      };
    };

    const turn = runTurn(h.ctx, ctrl);
    await questionWaiting;
    expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(true);
    expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual([]);
    await h.ctx.lifecycle.cancel('conv-1');

    await expect(turn).resolves.toMatchObject({ kind: 'cancelled' });
    expect(h.acquires).toBe(1);
    expect((pool as unknown as { releases: number }).releases).toBe(1);
    expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(false);
    expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual([]);
  });

  it('fails safely when the original model cannot be reacquired after an answer', async () => {
    const pool = countingPool();
    const acquire = pool.acquireForTurn!;
    let acquisitions = 0;
    Object.assign(pool, {
      acquireForTurn: async (...args: Parameters<typeof acquire>) => {
        acquisitions += 1;
        if (acquisitions === 2) throw new Error('original model is unavailable');
        return acquire(...args);
      },
    });
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    h.ctx.runModelTurn = async (...args) => {
      const withQuestionWait = args[8]!;
      await withQuestionWait(async () => 'answer is saved');
      throw new Error('continuation must not run without the original model');
    };

    const outcome = await runTurn(h.ctx, ctrl);

    expect(outcome).toMatchObject({ kind: 'failed', error: 'original model is unavailable' });
    expect(acquisitions).toBe(2);
    expect((pool as unknown as { releases: number }).releases).toBe(1);
    expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(false);
    expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual([]);
  });

  it('stops during original model reacquisition without continuing the answered turn', async () => {
    const pool = countingPool();
    const acquire = pool.acquireForTurn!;
    let acquisitions = 0;
    let noteReacquiring!: () => void;
    const reacquiring = new Promise<void>((resolve) => (noteReacquiring = resolve));
    Object.assign(pool, {
      acquireForTurn: async (modelName: string, options?: { signal?: AbortSignal }) => {
        acquisitions += 1;
        if (acquisitions === 1) return acquire(modelName, options);
        return new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('Backend turn acquisition cancelled.')),
            { once: true },
          );
          noteReacquiring();
        });
      },
    });
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    let continued = false;
    h.ctx.runModelTurn = async (...args) => {
      const withQuestionWait = args[8]!;
      await withQuestionWait(async () => 'answer is saved');
      continued = true;
      return {
        finalText: 'answer',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      };
    };

    const turn = runTurn(h.ctx, ctrl);
    await reacquiring;
    await h.ctx.lifecycle.cancel('conv-1');

    await expect(turn).resolves.toMatchObject({ kind: 'cancelled' });
    expect(acquisitions).toBe(2);
    expect(continued).toBe(false);
    expect((pool as unknown as { releases: number }).releases).toBe(1);
    expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(false);
    expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual([]);
  });

  it('settles as failed when a cloud catch post throws', async () => {
    const target = vi.spyOn(cloudRequestResolver, 'resolveCloudRequestTarget');
    target.mockResolvedValue({ baseUrl: 'http://127.0.0.1:8091', apiKey: 'key' });
    const h = fakeHarness(countingPool());
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    const settle = vi.spyOn(h.ctx.lifecycle, 'settle');
    const finished = vi.fn();
    h.ctx.events.onGenerationFinished = finished;
    h.ctx.runModelTurn = async () => {
      throw new Error('cloud request failed');
    };
    const post = vi.fn((message: HostToWebview) => {
      if (message.type === 'error') throw new Error('error post failed');
    });

    try {
      await expect(
        runCloudProviderTurn(h.ctx, {
          conv: fakeConv(),
          model: { ...fakeModel('cloud'), provider: 'openai-compatible' },
          text: 'hello',
          attachments: undefined,
          activeFile: undefined,
          ctrl,
          postC: post,
        }),
      ).rejects.toThrow('error post failed');
      expect(settle).toHaveBeenCalledWith('conv-1');
      expect(finished).toHaveBeenCalledWith('cloud', 'conv-1', '', 'failed');
    } finally {
      target.mockRestore();
    }
  });

  it('releases and refreshes a cloud hold, endpoint, and key around a question', async () => {
    const pool = countingPool();
    let holds = 0;
    let releases = 0;
    Object.assign(pool, {
      acquireExternalTurnHold: async () => {
        holds += 1;
        return { release: () => (releases += 1) };
      },
    });
    const target = vi.spyOn(cloudRequestResolver, 'resolveCloudRequestTarget');
    target
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:8091', apiKey: 'key-one' })
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:8092', apiKey: 'key-two' });
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    h.ctx.runModelTurn = async (...args) => {
      const resolveBaseUrl = args[0];
      const withQuestionWait = args[8]!;
      const getApiKey = args[9]!;
      expect(await resolveBaseUrl()).toBe('http://127.0.0.1:8091');
      expect(args[6]).toBe('key-one');
      expect(getApiKey()).toBe('key-one');
      await withQuestionWait(async () => {
        expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(true);
        expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual([]);
        return 'answered';
      });
      expect(await resolveBaseUrl()).toBe('http://127.0.0.1:8092');
      expect(getApiKey()).toBe('key-two');
      return {
        finalText: 'answer',
        finishReason: 'stop',
        rounds: 1,
        repeatedCall: false,
        hitRoundCap: false,
      };
    };

    try {
      const outcome = await runCloudProviderTurn(h.ctx, {
        conv: fakeConv(),
        model: { ...fakeModel('cloud'), provider: 'openai-compatible' },
        text: 'hello',
        attachments: undefined,
        activeFile: undefined,
        ctrl,
        postC: vi.fn(),
      });

      expect(outcome.kind).toBe('completed');
      expect(holds).toBe(2);
      expect(releases).toBe(2);
      expect(h.ctx.lifecycle.isStreaming('conv-1')).toBe(false);
      expect([...h.ctx.lifecycle.modelDemandIds()]).toEqual([]);
    } finally {
      target.mockRestore();
    }
  });

  it('posts a template render failure as a visible failed turn', async () => {
    const h = fakeHarness(countingPool());
    const ctrl = new AbortController();
    const message = new SystemPromptRenderError('execute', new Error('broken block')).message;
    const post = vi.fn();
    h.ctx.lifecycle.register('conv-1', ctrl);
    h.ctx.runModelTurn = async () => {
      throw new SystemPromptRenderError('execute', new Error('broken block'));
    };

    const outcome = await runTurn(h.ctx, ctrl, post);

    expect(outcome).toMatchObject({ kind: 'failed', error: message });
    expect(post).toHaveBeenCalledWith({ type: 'error', message });
  });

  // The prompt is committed only after the backend is up; a failed start used
  // to lose it when the next sync dropped its optimistic row (U20-01).
  it('hands the prompt back to the composer when the backend fails to start', async () => {
    const pool = countingPool();
    (pool as unknown as { acquireForTurn: () => Promise<never> }).acquireForTurn = async () => {
      throw new Error('llama-server exited with code 1');
    };
    const h = fakeHarness(pool);
    const ctrl = new AbortController();
    const post = vi.fn();
    h.ctx.lifecycle.register('conv-1', ctrl);

    const outcome = await runTurn(h.ctx, ctrl, post);

    expect(outcome.kind).toBe('failed');
    expect(post).toHaveBeenCalledWith({ type: 'setInput', text: 'hello' });
  });

  it('releases the lease BEFORE settling when Stop lands during backend start', async () => {
    // Ordering, not just counting. `settle` is what tells the rest of the app
    // the turn is over; if the pin is still held at that moment there is a
    // window where the slot is neither in use nor evictable, and the outer
    // `finally` net alone would put the release on the wrong side of it.
    const order: string[] = [];
    const pool = countingPool(order);
    const h = fakeHarness(pool);
    const lifecycle = h.ctx.lifecycle;
    const settleReal = lifecycle.settle.bind(lifecycle);
    vi.spyOn(lifecycle, 'settle').mockImplementation((convId: string) => {
      order.push('settle');
      settleReal(convId);
    });
    const ctrl = new AbortController();
    lifecycle.register('conv-1', ctrl);

    const turn = runTurn(h.ctx, ctrl);
    ctrl.abort();
    const outcome = await turn;

    expect(outcome.kind).toBe('cancelled');
    expect(order).toEqual(['release', 'settle']);
    expect((pool as unknown as { releases: number }).releases).toBe(1);
  });

  it('a Stop during a cold load leaves the slot evictable (one-port pool)', async () => {
    const pool = new BackendPool(makeConfig(1)); // freePorts [8080]
    const h = fakeHarness(pool as unknown as ProviderTurnContext['pool']);
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);

    const turn = runTurn(h.ctx, ctrl);
    ctrl.abort(); // Stop while llama-server is still booting
    await flush();
    harness.pending[0].resolve(); // the boot finishes anyway
    const outcome = await turn;
    expect(outcome.kind).toBe('cancelled');

    expect(turnPinsOf(pool).size).toBe(0);
    expect(pool.isLoaded('A')).toBe(true);

    // The whole point: the next model must be able to evict A. Before the fix
    // this rejected with "no free slot and no eviction candidate — all resident
    // models are pinned by active delegation holds."
    const acquireB = pool.acquire('B');
    await flush();
    expect(harness.events).toEqual(['hotSwap:8080', 'stop:8080', 'hotSwap:8080']);
    harness.pending[1].resolve();
    await acquireB;
    expect(pool.loadedModelNames()).toEqual(['B']);
  });
});

describe('managed external turn failures', () => {
  it.each(['hold', 'startup'] as const)(
    'restores an uncommitted prompt after a %s refusal and permits retry',
    async (failureAt) => {
      const pool = countingPool();
      const release = vi.fn();
      const acquireHold = vi.fn().mockResolvedValue({ release });
      Object.assign(pool, { acquireExternalTurnHold: acquireHold });
      const target = vi.spyOn(cloudRequestResolver, 'resolveCloudRequestTarget');
      target.mockResolvedValue({ baseUrl: 'http://127.0.0.1:8080', apiKey: '' });
      const error = new Error('Cannot load model B: model A is serving another chat.');
      if (failureAt === 'hold') acquireHold.mockRejectedValueOnce(error);
      else target.mockRejectedValueOnce(error);
      const h = fakeHarness(pool);
      const commit = vi.fn();
      h.ctx.commitUserPrompt = commit;
      const post = vi.fn();
      const request = {
        conv: { ...fakeConv(), title: 'New chat' },
        model: { ...fakeModel('B'), provider: 'openai-compatible' as const },
        text: 'Keep this whole prompt\nso I can retry later.',
        attachments: undefined,
        activeFile: undefined,
        ctrl: new AbortController(),
        postC: post,
      };
      h.ctx.lifecycle.register(request.conv.id, request.ctrl);
      try {
        const outcome = await runCloudProviderTurn(h.ctx, request);

        expect(outcome).toEqual({ kind: 'failed', error: error.message, finalText: '' });
        expect(post).toHaveBeenCalledWith({ type: 'error', message: error.message });
        expect(post).toHaveBeenCalledWith({ type: 'setInput', text: request.text });
        expect(commit).not.toHaveBeenCalled();
        expect(h.modelTurnCalls).toBe(0);
        expect(release).toHaveBeenCalledTimes(failureAt === 'hold' ? 0 : 1);
        expect(h.ctx.lifecycle.isStreaming(request.conv.id)).toBe(false);

        post.mockClear();
        request.ctrl = new AbortController();
        h.ctx.lifecycle.register(request.conv.id, request.ctrl);
        const retry = await runCloudProviderTurn(h.ctx, request);

        expect(retry.kind).toBe('completed');
        expect(commit).toHaveBeenCalledExactlyOnceWith(
          request.conv,
          request.text,
          undefined,
          undefined,
        );
        expect(h.modelTurnCalls).toBe(1);
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setInput' }));
      } finally {
        target.mockRestore();
      }
    },
  );

  it('does not restore a prompt when the owner cancels external startup', async () => {
    const h = fakeHarness(countingPool());
    const ctrl = new AbortController();
    const post = vi.fn();
    const target = vi.spyOn(cloudRequestResolver, 'resolveCloudRequestTarget');
    target.mockImplementationOnce(async () => {
      ctrl.abort();
      throw new Error('Startup cancelled');
    });
    h.ctx.lifecycle.register('conv-1', ctrl);
    try {
      const outcome = await runCloudProviderTurn(h.ctx, {
        conv: fakeConv(),
        model: { ...fakeModel('B'), provider: 'openai-compatible' },
        text: 'cancelled prompt',
        attachments: undefined,
        activeFile: undefined,
        ctrl,
        postC: post,
      });
      expect(outcome.kind).toBe('cancelled');
      expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setInput' }));
    } finally {
      target.mockRestore();
    }
  });

  it('names an unloaded server and preserves the raw engine error', async () => {
    const h = fakeHarness(countingPool());
    h.ctx.runModelTurn = async () => {
      throw new Error('I/O operation on closed file.');
    };
    const outcome = await runCloudProviderTurn(h.ctx, {
      conv: { ...fakeConv(), title: 'Existing turn' },
      model: {
        name: 'iq2xs',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8080',
        unload_path: '/unload',
      } as ModelConfig,
      text: 'hello',
      attachments: undefined,
      activeFile: undefined,
      ctrl: new AbortController(),
      postC: () => {},
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('the model server stopped or was unloaded during this turn');
      expect(outcome.error).toContain('I/O operation on closed file.');
    }
  });
});

/**
 * BL-024 (bug hunt 2026-10-31): `finishTurn` used to run `settle` last and
 * unguarded, so a checkpoint commit that throws — it re-reads every file the
 * turn touched, and a file another process holds throws EPERM or EBUSY on
 * Windows — skipped it. `settle` is the only resolver of the promise
 * `TurnLifecycle.stopStreaming` awaits, so the next Stop, tab close or
 * `waitForCancelledTurns` then waited on a promise nothing could resolve, and
 * the chat could not send again in this window.
 */
describe('the turn unwind settles even when the checkpoint commit fails', () => {
  /** The errno text a held file produces, path included — what the user must see. */
  const heldFileError = (): Error =>
    Object.assign(new Error("EPERM: operation not permitted, lstat 'N:\\work\\a.ts'"), {
      code: 'EPERM',
    });

  function checkpointsThatThrow(): ProviderTurnContext['checkpoints'] {
    return {
      beginTurn: () => ({}),
      commitTurn: () => {
        throw heldFileError();
      },
      depth: () => 0,
    } as unknown as ProviderTurnContext['checkpoints'];
  }

  it('completes the turn, names the file, and lets Stop resolve', async () => {
    const h = fakeHarness(countingPool());
    h.ctx.checkpoints = checkpointsThatThrow();
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);
    const post = vi.fn();

    const outcome = await runTurn(h.ctx, ctrl, post);

    // The reply survives: the turn is completed, not failed.
    expect(outcome.kind).toBe('completed');
    // A warning notice, not an error row: the webview maps `error` to ERROR,
    // which would read as a failed turn when the answer arrived fine.
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notice',
        severity: 'warning',
        message: expect.stringContaining("lstat 'N:\\work\\a.ts'"),
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Undo will not cover this turn'),
      }),
    );
    // The conversation is settled, so the cancel path resolves instead of
    // awaiting a promise whose resolver the next turn already replaced.
    await Promise.all([h.ctx.lifecycle.cancel('conv-1'), flush()]);
    await h.ctx.lifecycle.waitForCancelledTurns();
    expect(h.ctx.lifecycle.isCancellationPending('conv-1')).toBe(false);
  });

  it('settles the cloud path too, so a managed external turn cannot hang the chat', async () => {
    const h = fakeHarness(countingPool());
    h.ctx.checkpoints = checkpointsThatThrow();
    const ctrl = new AbortController();
    h.ctx.lifecycle.register('conv-1', ctrl);

    const outcome = await runCloudProviderTurn(h.ctx, {
      conv: { ...fakeConv(), title: 'Strata chat' },
      model: {
        name: 'iq2xs',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8080',
        unload_path: '/unload',
      } as ModelConfig,
      text: 'hello',
      attachments: undefined,
      activeFile: undefined,
      ctrl,
      postC: () => {},
    });

    expect(outcome.kind).toBe('completed');
    await Promise.all([h.ctx.lifecycle.cancel('conv-1'), flush()]);
    await h.ctx.lifecycle.waitForCancelledTurns();
  });
});
