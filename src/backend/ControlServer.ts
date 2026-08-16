import * as http from 'http';
import type * as vscode from 'vscode';
import type { IBackendPool } from './BackendPool';
import type { ForgeConfig } from '../config/types';
import {
  expandAlias,
  splitModelProfile,
  resolveModelName,
  AmbiguousModelError,
} from '../config/ConfigResolver';
import { probeHealthy } from './HealthCheck';
// prettier-ignore
import { sendJson, requireModel, readJson, handleChat, CHAT_BODY_BYTES } from './controlHttp';
import type { ChatProxyFn } from '../llm/ControlChatProxy';
import { getLogger } from '../util/logger';
import type { IControlServerRegistry } from './ControlServerRegistry';
import { buildControlModelCatalog, type ControlModelCatalogEntry } from './ControlModelCatalog';
import {
  ensureModelLoaded,
  releaseHold,
  unloadModel,
  type ModelLifecycleContext,
} from './ControlModelLifecycle';

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
  /** Runs a buffered cloud-provider completion inside the extension host (where
   *  SecretStorage is readable). Absent ⇒ POST /chat returns 501. */
  chatProxy?: ChatProxyFn;
  registry?: IControlServerRegistry;
  version?: string;
}

export interface EnsureResult {
  status: number;
  body:
    | { baseUrl: string; model: string; backend: 'llama.cpp' | 'ollama' }
    | { error: string; candidates?: string[] };
}

export interface ControlStatus {
  listening: boolean;
  port: number;
  contractVersion: number;
  catalogVersion: string;
  models: ControlModelCatalogEntry[];
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
 *   POST /chat    {model, messages, …} → { content, finish_reason }  (buffered cloud completion)
 */
export class ControlServer implements vscode.Disposable {
  private server: http.Server | null = null;
  /** model → number of active /ensure holders (ref count). */
  private readonly holds = new Map<string, number>();
  /** model → epoch ms of its last successful acquire (eviction grace window). */
  private readonly lastAcquiredAt = new Map<string, number>();
  /** Models between acquire start and readiness completion. */
  private readonly loadingModels = new Set<string>();
  /** Serializes /ensure AND /release so capacity/eviction decisions are atomic. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly port: number;
  private readonly probe: (baseUrl: string) => Promise<boolean>;
  private readonly readinessTimeoutMs: number;
  private readonly readinessIntervalMs: number;
  private readonly evictionGraceMs: number;
  private readonly chatProxy?: ChatProxyFn;
  private readonly registry?: IControlServerRegistry;
  private readonly version: string;

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
    if (deps.chatProxy) this.chatProxy = deps.chatProxy;
    if (deps.registry) this.registry = deps.registry;
    this.version = deps.version ?? 'unknown';
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
      const url = `http://127.0.0.1:${this.port}`;
      log.info(`[ControlServer] listening on ${url}`);
      try {
        this.registry?.publish({
          url,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          version: this.version,
        });
        if (this.registry) log.info(`[ControlServer] published discovery record for ${url}`);
      } catch (err) {
        log.error('[ControlServer] failed to publish discovery record', err);
      }
    });
    this.server = server;
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
    try {
      this.registry?.removeIfOwned(process.pid);
    } catch (err) {
      log.error('[ControlServer] failed to remove discovery record', err);
    }
  }

  // ── public API for in-process callers (command palette) ─────────────────────

  /** Ensure a model is loaded + warm; same result shape as POST /ensure. */
  ensureModel(model: string): Promise<EnsureResult> {
    return this.serialize(() => ensureModelLoaded(this.lifecycle(), model));
  }

  /** Release one hold on a model (mirror of POST /release). Serialized so it
   *  cannot interleave with an in-flight /ensure mid-`holds` mutation. Throws
   *  `AmbiguousModelError` when a fuzzy name matches more than one model —
   *  callers must never guess between candidates. */
  releaseHold(model: string): Promise<boolean> {
    return this.serialize(async () => {
      const resolved = this.resolveBase(model);
      if (!('name' in resolved)) {
        const body = resolved.body as { error: string; candidates?: string[] };
        throw new AmbiguousModelError(model, body.candidates ?? []);
      }
      return releaseHold(this.lifecycle(), resolved.name);
    });
  }

  /** Snapshot for status UI: listener state + per-model loaded/hold counts. */
  status(): ControlStatus {
    const catalog = this.modelCatalog();
    return {
      listening: this.server !== null,
      port: this.port,
      ...catalog,
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
        return sendJson(res, 200, this.modelCatalog());
      }
      if (method === 'POST' && path === '/ensure') {
        const model = requireModel(await readJson(req));
        if (!model) return sendJson(res, 400, { error: 'model is required' });
        const result = await this.serialize(() => ensureModelLoaded(this.lifecycle(), model));
        return sendJson(res, result.status, result.body);
      }
      if (method === 'POST' && path === '/release') {
        const model = requireModel(await readJson(req));
        if (!model) return sendJson(res, 400, { error: 'model is required' });
        const resolved = this.resolveBase(model);
        if (!('name' in resolved)) return sendJson(res, resolved.status, resolved.body);
        const released = await this.serialize(async () =>
          releaseHold(this.lifecycle(), resolved.name),
        );
        return sendJson(res, 200, { released });
      }
      if (method === 'POST' && path === '/unload') {
        const model = requireModel(await readJson(req));
        if (!model) return sendJson(res, 400, { error: 'model is required' });
        const result = await this.serialize(() => unloadModel(this.lifecycle(), model));
        return sendJson(res, result.status, result.body);
      }
      if (method === 'POST' && path === '/chat') {
        // Not serialized: /chat neither loads nor evicts a local backend, so it
        // must run concurrently rather than block behind /ensure or /release.
        const { status, body } = await handleChat(
          this.chatProxy,
          await readJson(req, CHAT_BODY_BYTES),
        );
        return sendJson(res, status, body);
      }
      return sendJson(res, 404, { error: `no route for ${method} ${path}` });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private modelCatalog(): Pick<ControlStatus, 'contractVersion' | 'catalogVersion' | 'models'> {
    return buildControlModelCatalog({
      config: this.config,
      pool: this.pool,
      holds: this.holds,
      loadingModels: this.loadingModels,
      lastAcquiredAt: this.lastAcquiredAt,
      evictionGraceMs: this.evictionGraceMs,
      chatAvailable: this.chatProxy !== undefined,
    });
  }

  /** Normalize a control-API model id to the base model name: aliases expand and
   *  a trailing @profile is stripped (profiles are request-time only, F6). */
  private baseName(model: string): string {
    return splitModelProfile(expandAlias(this.config, model)).base;
  }

  /**
   * Resolve a control-API model id (possibly fuzzy/short, per CONFIG_OVERHAUL_PLAN
   * §4 step 8) to a base config model name. Alias expansion and @profile
   * stripping run first (F6); if the result isn't an exact model name, the F7
   * fuzzy resolver (name/alias/short_name, prefix, substring) runs on it. An
   * ambiguous fuzzy match returns a 400 with every candidate — never guesses.
   * A name that resolves to nothing (truly unknown) is passed through
   * unchanged so the existing per-route 404 handling stays in charge of the
   * "unknown model" response shape.
   */
  private resolveBase(requested: string): { name: string } | EnsureResult {
    const base = this.baseName(requested);
    if (this.config.models.some((m) => m.name === base)) return { name: base };
    try {
      return { name: resolveModelName(this.config, base) };
    } catch (err) {
      if (err instanceof AmbiguousModelError) {
        return { status: 400, body: { error: err.message, candidates: err.candidates } };
      }
      return { name: base };
    }
  }

  /** The state the lifecycle operations mutate on this server's behalf. */
  private lifecycle(): ModelLifecycleContext {
    return {
      config: this.config,
      pool: this.pool,
      holds: this.holds,
      loadingModels: this.loadingModels,
      lastAcquiredAt: this.lastAcquiredAt,
      probe: this.probe,
      readinessTimeoutMs: this.readinessTimeoutMs,
      readinessIntervalMs: this.readinessIntervalMs,
      evictionGraceMs: this.evictionGraceMs,
      resolveBase: (requested) => this.resolveBase(requested),
    };
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
