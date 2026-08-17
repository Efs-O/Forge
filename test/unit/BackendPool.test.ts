import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendPool } from '../../src/backend/BackendPool';
import type { ForgeConfig } from '../../src/config/types';

// Controllable stand-in for DirectBackend: each hotSwap parks a deferred the
// test settles by hand, so we can interleave release() with a failing boot.
const harness = vi.hoisted(() => ({
  pending: [] as Array<{ resolve: () => void; reject: (err: unknown) => void }>,
  exitCbs: [] as Array<() => void>,
  /** hotSwap/stop calls in order, so eviction ordering is observable. */
  events: [] as string[],
  /** While true, stop() parks until the test releases it. */
  blockStops: false,
  pendingStops: [] as Array<() => void>,
}));

function resetHarness(): void {
  harness.pending.length = 0;
  harness.exitCbs.length = 0;
  harness.events.length = 0;
  harness.pendingStops.length = 0;
  harness.blockStops = false;
}

/** Let every already-scheduled promise callback run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
      if (harness.blockStops) {
        await new Promise<void>((resolve) => harness.pendingStops.push(resolve));
      }
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
    onUnexpectedExit(cb: () => void): void {
      harness.exitCbs.push(cb);
    }
  }
  return { DirectBackend: FakeDirectBackend };
});

function makeConfig(maxModels: number): ForgeConfig {
  return {
    models: [
      { name: 'A', provider: 'llama.cpp', gguf_path: '/a.gguf' },
      { name: 'B', provider: 'llama.cpp', gguf_path: '/b.gguf' },
      { name: 'C', provider: 'llama.cpp', gguf_path: '/c.gguf' },
      { name: 'ollama-local', provider: 'ollama', model: 'local:latest' },
    ],
    active_model: 'A',
    llama_server: { port: 8080 },
    max_simultaneous_models: maxModels,
  } as ForgeConfig;
}

const freePortsOf = (pool: BackendPool): number[] =>
  (pool as unknown as { freePorts: number[] }).freePorts;

describe('BackendPool port accounting', () => {
  beforeEach(resetHarness);

  it('frees the slot when a ready backend dies unexpectedly (F5 reconcile)', async () => {
    const pool = new BackendPool(makeConfig(1)); // freePorts [8080]

    const acquireA = pool.acquire('A');
    harness.pending[0].resolve();
    await acquireA;
    expect(pool.loadedModelNames()).toEqual(['A']);
    expect(pool.isLoaded('A')).toBe(true);

    // External kill: the process exit handler fires the reconcile callback.
    harness.exitCbs[0]();
    expect(pool.loadedModelNames()).toEqual([]);
    expect(pool.isLoaded('A')).toBe(false);
    expect(freePortsOf(pool)).toEqual([8080]);

    // The freed port is immediately reusable for a different model.
    const acquireB = pool.acquire('B');
    harness.pending[1].resolve();
    await acquireB;
    expect(pool.loadedModelNames()).toEqual(['B']);
  });

  it('release() racing a failed boot frees the port exactly once', async () => {
    const pool = new BackendPool(makeConfig(2)); // freePorts [8080, 8081]

    const acquireP = pool.acquire('A'); // parks on hotSwap deferred
    acquireP.catch(() => {}); // settled below; silence unhandled-rejection
    const releaseP = pool.release('A'); // awaits the in-flight start

    harness.pending[0].reject(new Error('boom')); // boot fails under release
    await releaseP;
    await expect(acquireP).rejects.toThrow('boom');

    // Without the freeSlot ownership guard the port came back twice
    // ([8081, 8080, 8080]) and two future models could share one port.
    expect([...freePortsOf(pool)].sort()).toEqual([8080, 8081]);
    expect(pool.loadedModelNames()).toEqual([]);
  });

  it('keys slots by base model: @profile and aliases never force a second spawn (F6)', async () => {
    const cfg = makeConfig(1); // freePorts [8080]
    cfg.profiles = { main: {}, worker: {} };
    cfg.aliases = { 'A-legacy': 'A@worker' };
    const pool = new BackendPool(cfg);

    const acquireA = pool.acquire('A@worker');
    harness.pending[0].resolve();
    await acquireA;
    expect(pool.loadedModelNames()).toEqual(['A']); // base key, not "A@worker"

    // A different profile + the alias must reuse the same ready slot — no new
    // hotSwap deferred is created (harness.pending stays length 1).
    await pool.acquire('A@main');
    await pool.acquire('A-legacy');
    expect(harness.pending).toHaveLength(1);
    expect(pool.isLoaded('A@main')).toBe(true);
    expect(pool.isLoaded('A-legacy')).toBe(true);
  });

  it('waits for the evicted backend to exit before spawning its replacement', async () => {
    const pool = new BackendPool(makeConfig(1)); // one port: B must evict A

    const acquireA = pool.acquire('A');
    harness.pending[0].resolve();
    await acquireA;

    harness.blockStops = true; // A's process lingers, still holding its VRAM
    const acquireB = pool.acquire('B');
    await flush();

    // The eviction is under way but unfinished, so B must not have spawned:
    // two llama-servers alive at once is what OOM'd the GPU.
    expect(harness.events).toEqual(['hotSwap:8080', 'stop:8080']);
    expect(harness.pending).toHaveLength(1);
    // The slot is claimed synchronously, so a concurrent acquire of B joins
    // this boot rather than starting a second one.
    expect(pool.loadedModelNames()).toEqual(['B']);

    harness.pendingStops[0](); // A is finally gone
    await flush();
    expect(harness.events).toEqual(['hotSwap:8080', 'stop:8080', 'hotSwap:8080']);

    harness.pending[1].resolve();
    await acquireB;
    expect(pool.loadedModelNames()).toEqual(['B']);
    expect(freePortsOf(pool)).toEqual([]);
  });

  it('normal lifecycle returns the port once and reuses it', async () => {
    const pool = new BackendPool(makeConfig(1)); // freePorts [8080]

    const acquireA = pool.acquire('A');
    harness.pending[0].resolve();
    await acquireA;
    expect(pool.loadedModelNames()).toEqual(['A']);
    expect(freePortsOf(pool)).toEqual([]);

    await pool.release('A');
    expect(freePortsOf(pool)).toEqual([8080]);

    const acquireB = pool.acquire('B');
    harness.pending[1].resolve();
    await acquireB;
    expect(pool.loadedModelNames()).toEqual(['B']);
    expect(freePortsOf(pool)).toEqual([]);
  });
});

describe('BackendPool delegation safety', () => {
  beforeEach(resetHarness);

  it('rejects a second llama.cpp model at capacity without starting or evicting', async () => {
    const pool = new BackendPool(makeConfig(1));
    const acquireA = pool.acquire('A');
    harness.pending[0].resolve();
    await acquireA;

    const result = pool.canDelegate('A', 'B');

    expect(result.safe).toBe(false);
    expect(result.reason).toContain('B');
    expect(result.reason).toContain('max_simultaneous_models');
    expect(result.reason).toContain('VRAM');
    expect(pool.loadedModelNames()).toEqual(['A']);
    expect(harness.pending).toHaveLength(1);
  });

  it('allows a second llama.cpp model when a port is free', async () => {
    const pool = new BackendPool(makeConfig(2));
    const acquireA = pool.acquire('A');
    harness.pending[0].resolve();
    await acquireA;

    expect(pool.canDelegate('A', 'B')).toEqual({ safe: true });
  });

  it('allows the same base model across profiles', () => {
    const config = makeConfig(1);
    config.profiles = { main: {}, worker: {} };
    const pool = new BackendPool(config);

    expect(pool.canDelegate('A', 'A')).toEqual({ safe: true });
    expect(pool.canDelegate('A@main', 'A@worker')).toEqual({ safe: true });
  });

  it('allows an Ollama target on a best-effort basis', () => {
    const pool = new BackendPool(makeConfig(1));

    expect(pool.canDelegate('A', 'ollama-local')).toEqual({
      safe: true,
      bestEffort: true,
    });
  });
});

describe('BackendPool delegation holds', () => {
  beforeEach(resetHarness);

  async function loadPrimary(pool: BackendPool, name = 'A'): Promise<void> {
    const acquireP = pool.acquire(name);
    harness.pending[harness.pending.length - 1].resolve();
    await acquireP;
  }

  it('at capacity rejects a different llama.cpp target without starting or evicting', async () => {
    const pool = new BackendPool(makeConfig(1));
    await loadPrimary(pool);

    await expect(pool.acquireForDelegation('A', 'B')).rejects.toThrow('max_simultaneous_models');
    expect(pool.loadedModelNames()).toEqual(['A']);
    expect(harness.pending).toHaveLength(1); // no hotSwap was ever started
  });

  it('starts the target when a slot is free', async () => {
    const pool = new BackendPool(makeConfig(2));
    await loadPrimary(pool);

    const holdP = pool.acquireForDelegation('A', 'B');
    harness.pending[1].resolve();
    const hold = await holdP;

    expect(hold.targetKey).toBe('B');
    expect(hold.bestEffort).toBe(false);
    expect(pool.loadedModelNames().sort()).toEqual(['A', 'B']);
    hold.release();
  });

  it('reuses the same backend across profiles of one base model', async () => {
    const cfg = makeConfig(1);
    cfg.profiles = { main: {}, worker: {} };
    const pool = new BackendPool(cfg);
    await loadPrimary(pool, 'A@main');

    const hold = await pool.acquireForDelegation('A@main', 'A@worker');
    expect(harness.pending).toHaveLength(1); // no second spawn
    expect(hold.targetKey).toBe('A');
    hold.release();
  });

  it('reuses an already loaded target', async () => {
    const pool = new BackendPool(makeConfig(2));
    await loadPrimary(pool, 'A');
    await loadPrimary(pool, 'B');

    const hold = await pool.acquireForDelegation('A', 'B');
    expect(harness.pending).toHaveLength(2); // no new hotSwap
    hold.release();
  });

  it('a live hold pins primary and target against concurrent eviction; release unpins', async () => {
    const pool = new BackendPool(makeConfig(2));
    await loadPrimary(pool);
    const holdP = pool.acquireForDelegation('A', 'B');
    harness.pending[1].resolve();
    const hold = await holdP;

    // Concurrent acquire of a third model finds no eviction candidate.
    await expect(pool.acquire('C')).rejects.toThrow('delegation holds');
    expect(pool.loadedModelNames().sort()).toEqual(['A', 'B']);

    hold.release();
    hold.release(); // idempotent — extra calls are no-ops

    // After release, normal LRU eviction applies again. An evicting acquire
    // boots only once the evicted backend has stopped, so let that settle.
    const acquireC = pool.acquire('C');
    await flush();
    harness.pending[2].resolve();
    await acquireC;
    expect(pool.loadedModelNames()).toContain('C');
  });

  it.each(['success', 'cancellation', 'failure'] as const)(
    'releases the hold after delegated request %s',
    async (outcome) => {
      const pool = new BackendPool(makeConfig(2));
      await loadPrimary(pool);
      const holdP = pool.acquireForDelegation('A', 'B');
      harness.pending[1].resolve();
      const hold = await holdP;

      try {
        if (outcome === 'cancellation') throw new DOMException('cancelled', 'AbortError');
        if (outcome === 'failure') throw new Error('request failed');
      } catch {
        // The service owns propagation; this test exercises its required finally path.
      } finally {
        hold.release();
      }

      const acquireC = pool.acquire('C');
      await flush(); // evicting acquire: boots after the evicted backend stops
      harness.pending[2].resolve();
      await acquireC;
      expect(pool.loadedModelNames()).toContain('C');
    },
  );

  it('pins apply during the in-flight target boot (TOCTOU window)', async () => {
    const pool = new BackendPool(makeConfig(2));
    await loadPrimary(pool);
    const holdP = pool.acquireForDelegation('A', 'B'); // boot parked

    await expect(pool.acquire('C')).rejects.toThrow('delegation holds');

    harness.pending[1].resolve();
    const hold = await holdP;
    expect(pool.loadedModelNames().sort()).toEqual(['A', 'B']);
    hold.release();
  });

  it('a failed target boot rejects and unpins the primary', async () => {
    const pool = new BackendPool(makeConfig(2));
    await loadPrimary(pool);
    const holdP = pool.acquireForDelegation('A', 'B');
    holdP.catch(() => {});

    harness.pending[1].reject(new Error('boot boom'));
    await expect(holdP).rejects.toThrow('boot boom');

    // A is unpinned again: release() would throw if a hold still pinned it.
    await pool.release('A');
    expect(pool.loadedModelNames()).toEqual([]);
  });

  it('release() refuses to stop a model pinned by a live hold', async () => {
    const pool = new BackendPool(makeConfig(2));
    await loadPrimary(pool);
    const holdP = pool.acquireForDelegation('A', 'B');
    harness.pending[1].resolve();
    const hold = await holdP;

    await expect(pool.release('A')).rejects.toThrow('delegation hold');
    await expect(pool.release('B')).rejects.toThrow('delegation hold');

    hold.release();
    await pool.release('B');
    expect(pool.loadedModelNames()).toEqual(['A']);
  });

  it('Ollama targets produce best-effort holds', async () => {
    const pool = new BackendPool(makeConfig(1)); // ollama needs no port slot
    await loadPrimary(pool);

    const holdP = pool.acquireForDelegation('A', 'ollama-local');
    harness.pending[1].resolve();
    const hold = await holdP;
    expect(hold.bestEffort).toBe(true);
    expect(hold.targetKey).toBe('ollama-local');
    hold.release();
  });

  it('surfaces an Ollama daemon load failure clearly and unpins', async () => {
    const pool = new BackendPool(makeConfig(1));
    await loadPrimary(pool);
    const holdP = pool.acquireForDelegation('A', 'ollama-local');
    holdP.catch(() => {});

    harness.pending[1].reject(new Error('daemon stalled'));
    await expect(holdP).rejects.toThrow(
      'Ollama daemon failed to load delegation target "ollama-local": daemon stalled',
    );
    await pool.release('A'); // primary unpinned again
  });
});
