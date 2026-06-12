import * as http from 'http';
import type * as vscode from 'vscode';
import type { IBackendPool } from './BackendPool';
import type { ForgeConfig } from '../config/types';
import { isCloudProvider, getCloudProviderLabel } from '../llm/CloudProviders';
import { probeHealthy } from './HealthCheck';
import { sendJson, requireModel, readJson, delay, toOpenAiBase, errText } from './controlHttp';
import { getLogger } from '../util/logger';

const log = getLogger();
const DEFAULT_PORT = 8799;
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
  models: Array<{ name: string; backend: string; loaded: boolean; holds: number; servable: boolean }>;
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
 *   POST /release {model} → { released: boolean }        (hold bookkeeping only)
 *   POST /unload  {model} → { unloaded: boolean }        (eager teardown; 409 if held)
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

  constructor(
    private readonly pool: IBackendPool,
    private config: ForgeConfig,
    deps: ControlServerDeps = {},
  ) {
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
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.warn(
          `[ControlServer] port ${this.port} in use — another Forge window likely owns it; not starting a second.`,
        );
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
    return {
      listening: this.server !== null,
      port: this.port,
      models: this.modelList(),
    };
  }

  // ── request routing ─────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      const path = (req.url ?? '/').split('?')[0];

      if (method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/models') {
        return sendJson(res, 200, { models: this.modelList() });
      }
      if (method === 'POST' && path === '/ensure') {
        const model = requireModel(await readJson(req));
        if (!model) return sendJson(res, 400, { error: 'model is required' });
        const result = await this.serialize(() => this.ensure(model));
        return sendJson(res, result.status, result.body);
      }
      if (method === 'POST' && path === '/release') {
        const model = requireModel(await readJson(req));
        if (!model) return sendJson(res, 400, { error: 'model is required' });
        const released = await this.serialize(async () => this.release(model));
        return sendJson(res, 200, { released });
      }
      if (method === 'POST' && path === '/unload') {
        const model = requireModel(await readJson(req));
        if (!model) return sendJson(res, 400, { error: 'model is required' });
        const result = await this.serialize(() => this.unload(model));
        return sendJson(res, result.status, result.body);
      }
      return sendJson(res, 404, { error: `no route for ${method} ${path}` });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private modelList(): ControlStatus['models'] {
    return this.config.models.map((m) => ({
      name: m.name,
      backend: m.provider ?? 'llama.cpp',
      loaded: this.pool.isLoaded(m.name),
      holds: this.holds.get(m.name) ?? 0,
      // Cloud-provider models are called via their HTTP API from inside the
      // extension (key in SecretStorage) — the control server cannot serve them.
      servable: !isCloudProvider(m.provider),
    }));
  }

  // ── core: ensure the requested model is loaded + warm ───────────────────────

  private async ensure(model: string): Promise<EnsureResult> {
    const known = this.config.models.find((m) => m.name === model);
    if (!known) {
      return { status: 404, body: { error: `unknown model "${model}" — not in config` } };
    }
    // Cloud-provider models have no local backend to load. Reject with the
    // reason BEFORE the capacity guard, so a bad dispatch can never evict a
    // loaded local model as collateral.
    if (isCloudProvider(known.provider)) {
      return {
        status: 422,
        body: {
          error:
            `"${model}" is a ${getCloudProviderLabel(known.provider)} cloud-provider model — ` +
            `the control server cannot serve it. Its API key lives in VS Code SecretStorage, so it is ` +
            `only callable from inside the Forge extension (sidebar). External callers must use the ` +
            `provider's API directly. GET /models marks such entries "servable": false.`,
        },
      };
    }
    const isOllama = known.provider === 'ollama';

    // Capacity guard applies only to port-consuming (llama.cpp) models. Ollama is
    // daemon-backed and unbounded, so it never needs a slot freed.
    if (!isOllama) {
      const guard = await this.makeRoom(model);
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
          body: {
            error: `"${model}" loaded but not ready: no HTTP response within ${this.readinessTimeoutMs}ms`,
          },
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
   * Free idle slots before loading `model`. VRAM — not the slot count — is the
   * binding constraint on local models (RELAY_SMOKE_FINDINGS.md F4): spawning a
   * second GGUF while an idle one still holds VRAM starves the new server until
   * its health timeout. So EVERY idle local model is released before the spawn,
   * not only when the slot table is full. Evictable = no holders AND not
   * acquired within the grace window (which stops a model whose ref-count
   * momentarily reads 0 between one worker's /release and the next /ensure from
   * being torn out from under a live request). Returns 409 when the in-use
   * models that remain already fill capacity; null when it is safe to proceed.
   */
  private async makeRoom(model: string): Promise<EnsureResult | null> {
    const loaded = this.pool.loadedModelNames();
    if (loaded.includes(model)) return null;

    const now = Date.now();
    const idle = loaded.filter(
      (m) =>
        (this.holds.get(m) ?? 0) === 0 &&
        now - (this.lastAcquiredAt.get(m) ?? 0) >= this.evictionGraceMs,
    );
    for (const victim of idle) {
      this.lastAcquiredAt.delete(victim);
      // Await each release: it frees the slot/port only after backend.stop()
      // resolves. Fire-and-forget here let the subsequent acquire race it —
      // allocatePort would LRU-evict the same slot and reuse its port, then the
      // in-flight release pushed that port back while the new slot occupied it.
      await this.pool.release(victim);
      log.info(`[ControlServer] released idle "${victim}" to make room for "${model}"`);
    }

    const remaining = loaded.length - idle.length;
    const capacity = this.config.max_simultaneous_models ?? 1;
    if (remaining >= capacity) {
      return {
        status: 409,
        body: {
          error:
            `busy: ${remaining} model(s) loaded and all in use or recently active; cannot load "${model}". ` +
            'Release a worker or raise max_simultaneous_models (needs the VRAM).',
        },
      };
    }
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

  /** Eager teardown (POST /unload): refuses while holds exist; otherwise stops
   *  the backend and frees its VRAM/slot. `release` stays pure bookkeeping. */
  private async unload(model: string): Promise<EnsureResult | { status: number; body: { unloaded: boolean } }> {
    const known = this.config.models.find((m) => m.name === model);
    if (!known) {
      return { status: 404, body: { error: `unknown model "${model}" — not in config` } };
    }
    if (isCloudProvider(known.provider)) {
      return { status: 422, body: { error: `"${model}" is a cloud-provider model — nothing local to unload` } };
    }
    if ((this.holds.get(model) ?? 0) > 0) {
      return { status: 409, body: { error: `"${model}" has active holds — POST /release them first` } };
    }
    const wasLoaded = this.pool.isLoaded(model);
    this.lastAcquiredAt.delete(model);
    await this.pool.release(model);
    if (wasLoaded) log.info(`[ControlServer] unloaded "${model}"`);
    return { status: 200, body: { unloaded: wasLoaded } };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

}
