import { describe, it, expect, afterEach } from 'vitest';
import { ControlServer } from '../../src/backend/ControlServer';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { BackendController } from '../../src/backend/BackendController';
import type { ForgeConfig } from '../../src/config/types';

function fakeController(model: string): BackendController {
  return {
    start: async () => {},
    stop: async () => {},
    showConsole: () => {},
    isReady: () => true,
    baseUrl: () => 'http://127.0.0.1:8080',
    loadedModel: () => model,
    hotSwap: async () => {},
    applyForgeConfig: () => {},
  };
}

class FakePool implements IBackendPool {
  readonly loaded = new Map<string, BackendController>();
  async acquire(name: string): Promise<BackendController> {
    if (!this.loaded.has(name)) this.loaded.set(name, fakeController(name));
    return this.loaded.get(name)!;
  }
  async release(name: string): Promise<void> { this.loaded.delete(name); }
  async stopAll(): Promise<void> { this.loaded.clear(); }
  applyForgeConfig(): void {}
  showConsole(): void {}
  isAnyReady(): boolean { return this.loaded.size > 0; }
  loadedModelNames(): string[] { return [...this.loaded.keys()]; }
}

function makeConfig(port: number): ForgeConfig {
  return {
    models: [
      { name: 'A', provider: 'llama.cpp', gguf_path: '/a.gguf' },
      { name: 'B', provider: 'llama.cpp', gguf_path: '/b.gguf' },
    ],
    active_model: 'A',
    llama_server: {},
    max_simultaneous_models: 1,
    control_server: { enabled: true, port },
  } as ForgeConfig;
}

async function waitReady(base: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('control server did not start');
}

const post = (base: string, model: string, route = 'ensure'): Promise<Response> =>
  fetch(`${base}/${route}`, { method: 'POST', body: JSON.stringify({ model }) });

describe('ControlServer', () => {
  let server: ControlServer | undefined;
  afterEach(() => { server?.dispose(); server = undefined; });

  it('ensures a model, ref-counts holders, and guards capacity against in-use eviction', async () => {
    const port = 18799;
    const base = `http://127.0.0.1:${port}`;
    const pool = new FakePool();
    server = new ControlServer(pool, makeConfig(port));
    server.start();
    await waitReady(base);

    // /ensure A → loads it; baseUrl normalized to include /v1.
    const a = await (await post(base, 'A')).json();
    expect(a.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(a.model).toBe('A');
    expect(pool.loadedModelNames()).toEqual(['A']);

    // capacity is 1 and A is held → /ensure B must 409 (never evict in-use A).
    const busy = await post(base, 'B');
    expect(busy.status).toBe(409);
    expect(pool.loadedModelNames()).toEqual(['A']);

    // release A (now idle) → /ensure B now fits and swaps in.
    expect((await (await post(base, 'A', 'release')).json()).released).toBe(true);
    const bOk = await post(base, 'B');
    expect(bOk.status).toBe(200);
    expect(pool.loadedModelNames()).toEqual(['B']);
  });

  it('404s an unknown model and an unknown route', async () => {
    const port = 18800;
    const base = `http://127.0.0.1:${port}`;
    server = new ControlServer(new FakePool(), makeConfig(port));
    server.start();
    await waitReady(base);

    expect((await post(base, 'Z')).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
