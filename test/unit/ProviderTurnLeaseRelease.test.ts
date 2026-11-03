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
  };
}

/** A pool fake whose acquireForTurn hands out a counting lease. */
function countingPool(order?: string[]): ProviderTurnContext['pool'] {
  const state = { releases: 0 };
  const pool = {
    acquireForTurn: async () => {
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
