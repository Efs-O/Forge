import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendPool } from '../../src/backend/BackendPool';
import type { ForgeConfig } from '../../src/config/types';

// Controllable stand-in for DirectBackend: each hotSwap parks a deferred the
// test settles by hand, so we can interleave release() with a failing boot.
const harness = vi.hoisted(() => ({
  pending: [] as Array<{ resolve: () => void; reject: (err: unknown) => void }>,
  exitCbs: [] as Array<() => void>,
}));

vi.mock('../../src/backend/DirectBackend', () => {
  class FakeDirectBackend {
    private ready = false;
    constructor(_config: unknown, private readonly port: number) {}
    hotSwap(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        harness.pending.push({
          resolve: () => { this.ready = true; resolve(); },
          reject,
        });
      });
    }
    async stop(): Promise<void> { this.ready = false; }
    isReady(): boolean { return this.ready; }
    baseUrl(): string { return `http://127.0.0.1:${this.port}`; }
    loadedModel(): string | null { return null; }
    applyForgeConfig(): void {}
    showConsole(): void {}
    async start(): Promise<void> {}
    onUnexpectedExit(cb: () => void): void { harness.exitCbs.push(cb); }
  }
  return { DirectBackend: FakeDirectBackend };
});

function makeConfig(maxModels: number): ForgeConfig {
  return {
    models: [
      { name: 'A', provider: 'llama.cpp', gguf_path: '/a.gguf' },
      { name: 'B', provider: 'llama.cpp', gguf_path: '/b.gguf' },
      { name: 'C', provider: 'llama.cpp', gguf_path: '/c.gguf' },
    ],
    active_model: 'A',
    llama_server: { port: 8080 },
    max_simultaneous_models: maxModels,
  } as ForgeConfig;
}

const freePortsOf = (pool: BackendPool): number[] =>
  (pool as unknown as { freePorts: number[] }).freePorts;

describe('BackendPool port accounting', () => {
  beforeEach(() => { harness.pending.length = 0; harness.exitCbs.length = 0; });

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
