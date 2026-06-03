import * as http from 'http';
import type * as vscode from 'vscode';
import type { IBackendPool } from './BackendPool';
import type { ForgeConfig } from '../config/types';
import { probeHealthy } from './HealthCheck';
import { getLogger } from '../util/logger';

const log = getLogger();
const DEFAULT_PORT = 8799;
const MAX_BODY_BYTES = 64 * 1024;
/** Upper bound on how long /ensure waits for a cold-loaded backend to answer. */
const READINESS_TIMEOUT_MS = 60_000;
/** Gap between readiness probes while a backend is warming up. */
const READINESS_INTERVAL_MS = 500;
/** A model acquired within this window is never LRU-evicted to make room. */
const EVICTION_GRACE_MS = 2_000;

/** Injectable knobs — defaults are production values; tests override them. */
export interface ControlServerDeps {
  /** Resolves true once the backend at baseUrl answers an HTTP request. */
  probe?: (baseUrl: string) => Promise<boolean>;
  readinessTimeoutMs?: number;
  readinessIntervalMs?: number;
  evictionGraceMs?: number;
}

export interface EnsureResult {
  status: number;
  body: { baseUrl: string; model: string; backend: 'llama.cpp' | 'ollama' } | { error: string };
}

export interface ControlStatus {
  listening: boolean;
  port: number;
  models: Array<{ name: string; backend: string; loaded: boolean; holds: number }>;
}

/**
 * Localhost model-control API. Lets an external orchestrator ask Forge to load
 * the right model on demand (BackendPool.acquire) and discover its OpenAI-
 * compatible endpoint, instead of POSTing blind to a fixed port. Consumer-
 * agnostic: Forge knows nothing about who calls it. Bound to 127.0.0.1 only.
 *
 * Routes:
 *   GET  /healthz         → { ok: true }
 *   GET  /models          → { models: [{ name, backend, loaded }] }
 *   POST /ensure  {model} → { baseUrl, model, backend }  (loads/swaps as needed)
 *   POST /release {model} → { released: boolean }
 */
export class ControlServer implements vscode.Disposable {
  private server: http.Server | null = null;
  /** model → number of active /ensure holders (ref count). */
  private readonly holds = new Map<string, number>();
  /** model → epoch ms of its last successful acquire (eviction grace window). */
  private readonly lastAcquiredAt = new Map<string, number>();
  /** Serializes /ensure AND /release so capacity/eviction decisions are atomic. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly port: number;
  private readonly probe: (baseUrl: string) => Promise<boolean>;
  private readonly readinessTimeoutMs: number;
  private readonly readinessIntervalMs: number;
  private readonly evictionGraceMs: number;

  constructor(private readonly pool: IBackendPool, private config: ForgeConfig, deps: ControlServerDeps = {}) {
    this.port = config.control_server?.port ?? DEFAULT_PORT;
    this.probe = deps.probe ?? probeHealthy;
    this.readinessTimeoutMs = deps.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
    this.readinessIntervalMs = deps.readinessIntervalMs ?? READINESS_INTERVAL_MS;
    this.evictionGraceMs = deps.evictionGraceMs ?? EVICTION_GRACE_MS;
  }

  applyForgeConfig(next: ForgeConfig): void {
    this.config = next;
  }

  start(): void {
    if (this.server) return;
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.warn(`[ControlServer] port ${this.port} in use — another Forge window likely owns it; not starting a second.`);
      } else {
        log.error(`[ControlServer] ${err.message}`);
      }
      this.server = null;
    });
    // 127.0.0.1 only — never expose beyond localhost.
    server.listen(this.port, '127.0.0.1', () => {
      log.info(`[ControlServer] listening on http://127.0.0.1:${this.port}`);
    });
    this.server = server;
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
  }

  // ── public API for in-process callers (command palette) ─────────────────────

  /** Ensure a model is loaded + warm; same result shape as POST /ensure. */
  ensureModel(model: string): Promise<EnsureResult> {
    return this.serialize(() => this.ensure(model));
  }

  /** Release one hold on a model (mirror of POST /release). Serialized so it
   *  cannot interleave with an in-flight /ensure mid-`holds` mutation. */
  releaseHold(model: string): Promise<boolean> {
    return this.serialize(async () => this.release(model));
  }

  /** Snapshot for status UI: listener state + per-model loaded/hold counts. */
  status(): ControlStatus {
    const loaded = new Set(this.pool.loadedModelNames());
    return {
      listening: this.server !== null,
      port: this.port,
      models: this.config.models.map((m) => ({
        name: m.name,
        backend: m.provider ?? 'llama.cpp',
        loaded: loaded.has(m.name),
        holds: this.holds.get(m.name) ?? 0,
      })),
    };
  }

  // ── request routing ─────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      const path = (req.url ?? '/').split('?')[0];

      if (method === 'GET' && path === '/healthz') {
        return this.json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/models') {
        return this.json(res, 200, { models: this.modelList() });
      }
      if (method === 'POST' && path === '/ensure') {
        const model = this.requireModel(await readJson(req));
        if (!model) return this.json(res, 400, { error: 'model is required' });
        const result = await this.serialize(() => this.ensure(model));
        return this.json(res, result.status, result.body);
      }
      if (method === 'POST' && path === '/release') {
        const model = this.requireModel(await readJson(req));
        if (!model) return this.json(res, 400, { error: 'model is required' });
        const released = await this.serialize(async () => this.release(model));
        return this.json(res, 200, { released });
      }
      return this.json(res, 404, { error: `no route for ${method} ${path}` });
    } catch (err) {
      this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private requireModel(body: Record<string, unknown>): string | null {
    const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
    return model || null;
  }

  private modelList(): Array<{ name: string; backend: string; loaded: boolean; holds: number }> {
    const loaded = new Set(this.pool.loadedModelNames());
    return this.config.models.map((m) => ({
      name: m.name,
      backend: m.provider ?? 'llama.cpp',
      loaded: loaded.has(m.name),
      holds: this.holds.get(m.name) ?? 0,
    }));
  }

  // ── core: ensure the requested model is loaded + warm ───────────────────────

  private async ensure(model: string): Promise<EnsureResult> {
    const known = this.config.models.find((m) => m.name === model);
    if (!known) {
      return { status: 404, body: { error: `unknown model "${model}" — not in config` } };
    }
    const isOllama = known.provider === 'ollama';

    // Capacity guard applies only to port-consuming (llama.cpp) models. Ollama is
    // daemon-backed and unbounded, so it never needs a slot freed.
    if (!isOllama) {
      const guard = this.makeRoom(model);
      if (guard) return guard;
    }

    try {
      const backend = await this.pool.acquire(model);
      // Readiness gate: the process can be spawned but not yet accepting HTTP
      // (a cold 26B takes ~30 s). Returning a baseUrl before the backend serves
      // is what lets a consumer's immediate POST hit ECONNRESET. llama.cpp only —
      // Ollama is daemon-backed and already serving when acquire resolves.
      if (!isOllama && !(await this.waitReady(backend.baseUrl()))) {
        return {
          status: 502,
          body: { error: `"${model}" loaded but not ready: no HTTP response within ${this.readinessTimeoutMs}ms` },
        };
      }
      this.holds.set(model, (this.holds.get(model) ?? 0) + 1);
      this.lastAcquiredAt.set(model, Date.now());
      return {
        status: 200,
        body: {
          baseUrl: toOpenAiBase(backend.baseUrl()),
          model: backend.loadedModel() ?? model,
          backend: isOllama ? 'ollama' : 'llama.cpp',
        },
      };
    } catch (err) {
      return { status: 502, body: { error: `failed to load "${model}": ${errText(err)}` } };
    }
  }

  /** Poll the backend until it answers an HTTP request or the timeout elapses. */
  private async waitReady(baseUrl: string): Promise<boolean> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    for (;;) {
      if (await this.probe(baseUrl)) return true;
      if (Date.now() >= deadline) return false;
      await delay(this.readinessIntervalMs);
    }
  }

  /**
   * If loading `model` would exceed capacity, free an *idle* slot first so the
   * pool never LRU-evicts a model a worker is mid-request on. Returns a 409
   * result if every loaded model is in use; null if there is room.
   */
  private makeRoom(model: string): EnsureResult | null {
    const loaded = this.pool.loadedModelNames();
    if (loaded.includes(model)) return null;

    const capacity = this.config.max_simultaneous_models ?? 1;
    if (loaded.length < capacity) return null;

    // Evictable = no holders AND not acquired within the grace window. The grace
    // window stops a model whose ref-count momentarily reads 0 (between one
    // worker's /release and the next worker's /ensure) from being torn out from
    // under a live request. Combined with serialized /release, holds is always
    // read from a consistent snapshot inside this critical section.
    const now = Date.now();
    const idle = loaded.filter(
      (m) => (this.holds.get(m) ?? 0) === 0
        && now - (this.lastAcquiredAt.get(m) ?? 0) >= this.evictionGraceMs,
    );
    if (idle.length === 0) {
      return {
        status: 409,
        body: {
          error: `busy: ${loaded.length} model(s) loaded and all in use or recently active; cannot load "${model}". `
            + 'Release a worker or raise max_simultaneous_models (needs the VRAM).',
        },
      };
    }
    this.lastAcquiredAt.delete(idle[0]);
    void this.pool.release(idle[0]);
    log.info(`[ControlServer] released idle "${idle[0]}" to make room for "${model}"`);
    return null;
  }

  private release(model: string): boolean {
    const current = this.holds.get(model) ?? 0;
    if (current <= 0) return false;
    const next = current - 1;
    if (next === 0) this.holds.delete(model);
    else this.holds.set(model, next);
    return true;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toOpenAiBase(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(u) ? u : `${u}/v1`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error('request body too large')); return; }
      data += chunk.toString();
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data) as Record<string, unknown>); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
