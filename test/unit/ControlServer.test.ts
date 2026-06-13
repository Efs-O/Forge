import { describe, it, expect, afterEach } from 'vitest';
import { ControlServer, type ControlServerDeps } from '../../src/backend/ControlServer';
import { ProxyError } from '../../src/llm/ControlChatProxy';
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
  /** When set, acquire waits this long — lets concurrent /ensure calls overlap. */
  acquireDelayMs = 0;
  async acquire(name: string): Promise<BackendController> {
    if (this.acquireDelayMs) await new Promise((r) => setTimeout(r, this.acquireDelayMs));
    if (!this.loaded.has(name)) this.loaded.set(name, fakeController(name));
    return this.loaded.get(name)!;
  }
  async release(name: string): Promise<void> { this.loaded.delete(name); }
  async stopAll(): Promise<void> { this.loaded.clear(); }
  applyForgeConfig(): void {}
  showConsole(): void {}
  isAnyReady(): boolean { return this.loaded.size > 0; }
  loadedModelNames(): string[] { return [...this.loaded.keys()]; }
  isLoaded(name: string): boolean { return this.loaded.has(name); }
}

function makeConfig(port: number, maxModels = 1): ForgeConfig {
  return {
    models: [
      { name: 'A', provider: 'llama.cpp', gguf_path: '/a.gguf' },
      { name: 'B', provider: 'llama.cpp', gguf_path: '/b.gguf' },
      { name: 'grok', provider: 'xai', api_key_secret: 'forge.xai' },
    ],
    active_model: 'A',
    llama_server: {},
    max_simultaneous_models: maxModels,
    control_server: { enabled: true, port },
  } as ForgeConfig;
}

// Default test deps: probe always passes instantly, no eviction grace. Individual
// tests override what they exercise (slow/failing probe, grace window).
const testDeps = (over: ControlServerDeps = {}): ControlServerDeps => ({
  probe: async () => true,
  readinessIntervalMs: 5,
  readinessTimeoutMs: 500,
  evictionGraceMs: 0,
  ...over,
});

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
    server = new ControlServer(pool, makeConfig(port), testDeps());
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
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps());
    server.start();
    await waitReady(base);

    expect((await post(base, 'Z')).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('/ensure blocks until the readiness probe passes (cold load)', async () => {
    const port = 18801;
    const base = `http://127.0.0.1:${port}`;
    let serving = false;
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps({
      probe: async () => serving,
      readinessTimeoutMs: 2000,
    }));
    server.start();
    await waitReady(base);

    const inflight = post(base, 'A');
    // Backend not serving yet → request stays pending.
    await new Promise((r) => setTimeout(r, 50));
    let settled = false;
    void inflight.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    serving = true;
    const res = await inflight;
    expect(res.status).toBe(200);
  });

  it('/ensure returns 502 when the backend never becomes ready', async () => {
    const port = 18802;
    const base = `http://127.0.0.1:${port}`;
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps({
      probe: async () => false,
      readinessTimeoutMs: 60,
    }));
    server.start();
    await waitReady(base);

    const res = await post(base, 'A');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/loaded but not ready/);
  });

  it('serializes concurrent /ensure + /release; holds never goes negative', async () => {
    const port = 18803;
    const base = `http://127.0.0.1:${port}`;
    const pool = new FakePool();
    pool.acquireDelayMs = 10; // force the ensure calls to overlap
    server = new ControlServer(pool, makeConfig(port, 4), testDeps());
    server.start();
    await waitReady(base);

    // 4 concurrent same-model ensures interleaved with releases.
    const ensures = Array.from({ length: 4 }, () => post(base, 'A'));
    const releases = Array.from({ length: 4 }, () => post(base, 'A', 'release'));
    const results = await Promise.all([...ensures, ...releases]);

    for (const r of results) expect([200, 409].includes(r.status)).toBe(true);
    // After the dust settles, drain remaining holds; release must never report
    // a hold that was never granted beyond the count of successful ensures.
    const holds = server.status().models.find((m) => m.name === 'A')!.holds;
    expect(holds).toBeGreaterThanOrEqual(0);
    expect(holds).toBeLessThanOrEqual(4);
  });

  it('does not evict a model acquired within the eviction grace window', async () => {
    const port = 18804;
    const base = `http://127.0.0.1:${port}`;
    const pool = new FakePool();
    server = new ControlServer(pool, makeConfig(port, 1), testDeps({ evictionGraceMs: 10_000 }));
    server.start();
    await waitReady(base);

    // Acquire A then immediately release it → holds 0 but lastAcquiredAt is fresh.
    expect((await post(base, 'A')).status).toBe(200);
    expect((await (await post(base, 'A', 'release')).json()).released).toBe(true);

    // /ensure B at capacity must NOT evict the just-acquired A (grace window).
    const busy = await post(base, 'B');
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toMatch(/recently active/);
    expect(pool.loadedModelNames()).toEqual(['A']);
  });

  it('422s a cloud-provider model with the reason, without evicting a loaded local model', async () => {
    const port = 18806;
    const base = `http://127.0.0.1:${port}`;
    const pool = new FakePool();
    server = new ControlServer(pool, makeConfig(port, 1), testDeps());
    server.start();
    await waitReady(base);

    // Load A, release the hold → A is idle and would be evictable.
    expect((await post(base, 'A')).status).toBe(200);
    expect((await (await post(base, 'A', 'release')).json()).released).toBe(true);

    // Dispatching the xai model must fail with the reason — and must NOT have
    // evicted idle A as collateral.
    const res = await post(base, 'grok');
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/cloud-provider model.*cannot serve/s);
    expect(pool.loadedModelNames()).toEqual(['A']);
  });

  it('marks cloud-provider models servable: false on GET /models', async () => {
    const port = 18807;
    const base = `http://127.0.0.1:${port}`;
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps());
    server.start();
    await waitReady(base);

    const { models } = await (await fetch(`${base}/models`)).json();
    const byName = Object.fromEntries(models.map((m: { name: string; servable: boolean }) => [m.name, m.servable]));
    expect(byName).toEqual({ A: true, B: true, grok: false });
  });

  it('evicts ALL idle local models before loading a different one, even under capacity', async () => {
    const port = 18808;
    const base = `http://127.0.0.1:${port}`;
    const pool = new FakePool();
    // capacity 4: slots are NOT the constraint — VRAM-policy eviction must
    // still unload idle A before spawning B (RELAY_SMOKE_FINDINGS.md F4).
    server = new ControlServer(pool, makeConfig(port, 4), testDeps());
    server.start();
    await waitReady(base);

    expect((await post(base, 'A')).status).toBe(200);
    expect((await (await post(base, 'A', 'release')).json()).released).toBe(true);

    expect((await post(base, 'B')).status).toBe(200);
    expect(pool.loadedModelNames()).toEqual(['B']);

    // Re-ensuring the already-loaded model must NOT evict it.
    expect((await post(base, 'B')).status).toBe(200);
    expect(pool.loadedModelNames()).toEqual(['B']);
  });

  it('POST /unload tears down an idle model, refuses a held one, 422s cloud', async () => {
    const port = 18809;
    const base = `http://127.0.0.1:${port}`;
    const pool = new FakePool();
    server = new ControlServer(pool, makeConfig(port, 4), testDeps());
    server.start();
    await waitReady(base);

    // Held → 409, still loaded.
    expect((await post(base, 'A')).status).toBe(200);
    const held = await post(base, 'A', 'unload');
    expect(held.status).toBe(409);
    expect((await held.json()).error).toMatch(/active holds/);
    expect(pool.loadedModelNames()).toEqual(['A']);

    // Released → unload actually frees it (unlike /release, which is bookkeeping).
    expect((await (await post(base, 'A', 'release')).json()).released).toBe(true);
    expect(pool.loadedModelNames()).toEqual(['A']);
    const ok = await post(base, 'A', 'unload');
    expect(ok.status).toBe(200);
    expect((await ok.json()).unloaded).toBe(true);
    expect(pool.loadedModelNames()).toEqual([]);

    // Not loaded → 200 unloaded:false; cloud → 422; unknown → 404.
    expect((await (await post(base, 'A', 'unload')).json()).unloaded).toBe(false);
    expect((await post(base, 'grok', 'unload')).status).toBe(422);
    expect((await post(base, 'Z', 'unload')).status).toBe(404);
  });

  it('exposes per-model holds on GET /models', async () => {
    const port = 18805;
    const base = `http://127.0.0.1:${port}`;
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps());
    server.start();
    await waitReady(base);

    await post(base, 'A');
    const { models } = await (await fetch(`${base}/models`)).json();
    const a = models.find((m: { name: string }) => m.name === 'A');
    expect(a.holds).toBe(1);
    expect(a.loaded).toBe(true);
  });

  const chat = (base: string, body: unknown): Promise<Response> =>
    fetch(`${base}/chat`, { method: 'POST', body: JSON.stringify(body) });

  it('POST /chat 501s when no chatProxy is wired', async () => {
    const port = 18810;
    const base = `http://127.0.0.1:${port}`;
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps());
    server.start();
    await waitReady(base);

    const res = await chat(base, { model: 'grok', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(501);
  });

  it('POST /chat validates model and messages, then delegates to the proxy', async () => {
    const port = 18811;
    const base = `http://127.0.0.1:${port}`;
    const chatProxy = async (req: { model: string; messages: unknown[] }) => ({
      content: `echo:${req.model}:${req.messages.length}`,
      reasoning: '',
      finishReason: 'stop',
    });
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps({ chatProxy }));
    server.start();
    await waitReady(base);

    expect((await chat(base, { messages: [{ role: 'user', content: 'x' }] })).status).toBe(400);
    expect((await chat(base, { model: 'grok' })).status).toBe(400);
    expect((await chat(base, { model: 'grok', messages: [] })).status).toBe(400);

    const ok = await chat(base, { model: 'grok', messages: [{ role: 'user', content: 'x' }] });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({
      model: 'grok',
      choices: [{ index: 0, message: { role: 'assistant', content: 'echo:grok:1' }, finish_reason: 'stop' }],
    });
  });

  it('POST /chat forwards tools and returns buffered tool_calls in OpenAI shape', async () => {
    const port = 18813;
    const base = `http://127.0.0.1:${port}`;
    const toolCalls = [
      { id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } },
    ];
    const chatProxy = async (req: { tools?: unknown }) => ({
      content: '',
      reasoning: '',
      finishReason: 'tool_calls',
      // echo back whether tools were forwarded by populating tool_calls only then.
      ...(req.tools ? { toolCalls } : {}),
    });
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps({ chatProxy }));
    server.start();
    await waitReady(base);

    const tools = [
      { type: 'function', function: { name: 'read_file', description: 'd', parameters: {} } },
    ];
    const res = await chat(base, { model: 'grok', messages: [{ role: 'user', content: 'x' }], tools });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.tool_calls).toEqual(toolCalls);
    expect(body.choices[0].finish_reason).toBe('tool_calls');

    // a malformed tools array is rejected, never blobbed.
    const bad = await chat(base, {
      model: 'grok',
      messages: [{ role: 'user', content: 'x' }],
      tools: ['not-a-tool'],
    });
    expect(bad.status).toBe(400);
  });

  it('POST /chat maps a ProxyError status faithfully', async () => {
    const port = 18812;
    const base = `http://127.0.0.1:${port}`;
    const chatProxy = async () => { throw new ProxyError(422, 'use /ensure for local models'); };
    server = new ControlServer(new FakePool(), makeConfig(port), testDeps({ chatProxy }));
    server.start();
    await waitReady(base);

    const res = await chat(base, { model: 'A', messages: [{ role: 'user', content: 'x' }] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('/ensure');
  });
});
