import * as http from 'http';
import type * as vscode from 'vscode';
import type { IBackendPool } from './BackendPool';
import type { ForgeConfig } from '../config/types';
import { getLogger } from '../util/logger';

const log = getLogger();
const DEFAULT_PORT = 8799;
const MAX_BODY_BYTES = 64 * 1024;

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
  /** Serializes /ensure so capacity/eviction decisions are atomic. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly port: number;

  constructor(private readonly pool: IBackendPool, private config: ForgeConfig) {
    this.port = config.control_server?.port ?? DEFAULT_PORT;
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

  /** Release one hold on a model (mirror of POST /release). */
  releaseHold(model: string): boolean {
    return this.release(model);
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
        return this.json(res, 200, { released: this.release(model) });
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

  private modelList(): Array<{ name: string; backend: string; loaded: boolean }> {
    const loaded = new Set(this.pool.loadedModelNames());
    return this.config.models.map((m) => ({
      name: m.name,
      backend: m.provider ?? 'llama.cpp',
      loaded: loaded.has(m.name),
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
      this.holds.set(model, (this.holds.get(model) ?? 0) + 1);
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

    const idle = loaded.filter((m) => (this.holds.get(m) ?? 0) === 0);
    if (idle.length === 0) {
      return {
        status: 409,
        body: {
          error: `busy: ${loaded.length} model(s) loaded and all in use; cannot load "${model}". `
            + 'Release a worker or raise max_simultaneous_models (needs the VRAM).',
        },
      };
    }
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
