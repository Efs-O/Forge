/**
 * Shared harness for the model starter tests (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md).
 *
 * One fake pool that answers both contracts the starter reads — `IBackendPool`
 * (what the control-server lifecycle uses) and `StarterPool` (what
 * `ModelStarterEnsure` uses) — so the ensure tests exercise the REAL
 * `ensureModelLoaded` capacity guard and readiness wait instead of stubbing
 * them out. `ControlServer` is faked by the one method the starter calls.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { listenLoopback } from './listenLoopback';
import { ModelStarterServer } from '../../src/backend/ModelStarterServer';
import { ModelStarterLeases } from '../../src/backend/ModelStarterLeases';
import type { BackendPool } from '../../src/backend/BackendPool';
import type { ControlServer } from '../../src/backend/ControlServer';
import type { ModelLifecycleContext } from '../../src/backend/ControlModelLifecycle';
import type { BackendController } from '../../src/backend/BackendController';
import type { DelegationCheck, DelegationHold } from '../../src/backend/DelegationGate';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';

/** The desktop config the starter tests read: one model of every kind, on the
 *  ports the real desktop config uses (8070 Maya, 8090-8092 Strata, 8080-8083
 *  the llama.cpp pool), plus ports deliberately left out of `shared_ports`. */
export function makeStarterConfig(
  overrides: { sharedPorts?: number[]; leaseTtlS?: number; port?: number } = {},
): ForgeConfig {
  const models: ModelConfig[] = [
    { name: 'gemma-iq3s', provider: 'llama.cpp', gguf_path: '/gemma.gguf', num_ctx: 131072 },
    { name: 'gemma-iq2xs', provider: 'llama.cpp', gguf_path: '/gemma2.gguf', num_ctx: 131072 },
    {
      name: 'strata-iq3s',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8090',
      unload_path: '/unload',
      num_ctx: 262144,
      display_name: 'Qwen Flash-Next (desktop Strata)',
      capabilities: ['tool-call'],
    },
    {
      name: 'maya-m2',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8070',
      unload_path: '/unload',
      num_ctx: 131072,
    },
    {
      name: 'strata-offacl',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8095',
      unload_path: '/unload',
    },
    { name: 'cerebras', provider: 'openai-compatible', endpoint: 'https://api.cerebras.ai' },
    { name: 'grok', provider: 'openrouter', api_key_secret: 'forge.grok' },
    { name: 'llama3', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
    { name: 'claude-code', provider: 'cli', cli: 'claude' },
  ];
  return {
    models,
    active_model: 'gemma-iq3s',
    llama_server: { port: 8080 },
    max_simultaneous_models: 4,
    control_server: { enabled: true, port: 8799 },
    model_starter: {
      enabled: true,
      port: overrides.port ?? 0,
      shared_ports: overrides.sharedPorts ?? [8070, 8080, 8081, 8082, 8083, 8090, 8091, 8092, 8094],
      lease_ttl_s: overrides.leaseTtlS ?? 600,
    },
  } as ForgeConfig;
}

/** A pool that records what the starter did to it. Every counter the lease
 *  tests care about (`pinsTaken`, `unpins`) is exact. */
export class FakeStarterPool {
  pins = new Map<string, number>();
  pinsTaken = 0;
  unpins = 0;
  loaded = new Map<string, number | null>();
  busyNames = new Set<string>();
  notReady = new Set<string>();
  prepareExternalCalls: string[] = [];
  prepareExternalError: Error | undefined;
  acquireError: Error | undefined;
  /** Ports handed out in order, like `claimPort` does. The desktop's real pool
   *  range is the default; a pass-through test has to hand out the ports of the
   *  fake model servers it started, so they are a constructor argument. */
  private readonly slotPorts: readonly number[];
  private nextPort = 0;
  releases: string[] = [];

  constructor(slotPorts: readonly number[] = [8080, 8081, 8082, 8083]) {
    this.slotPorts = slotPorts;
  }

  async acquire(name: string): Promise<BackendController> {
    if (this.acquireError) throw this.acquireError;
    const known = this.loaded.get(name);
    let port = known ?? null;
    if (port === null) {
      port = this.slotPorts[this.nextPort] ?? 8089;
      this.nextPort += 1;
      this.loaded.set(name, port);
    }
    return {
      start: async () => {},
      stop: async () => {},
      showConsole: () => {},
      isReady: () => true,
      baseUrl: () => `http://127.0.0.1:${port}`,
      loadedModel: () => name,
      hotSwap: async () => {},
      applyForgeConfig: () => {},
    };
  }
  async release(name: string): Promise<void> {
    this.releases.push(name);
    this.loaded.delete(name);
  }
  async stopAll(): Promise<void> {
    this.loaded.clear();
  }
  applyForgeConfig(): void {}
  showConsole(): void {}
  isAnyReady(): boolean {
    return this.loaded.size > 0;
  }
  loadedModelNames(): string[] {
    return [...this.loaded.keys()];
  }
  loadedModelsExcept(name: string): string[] {
    return this.loadedModelNames().filter((model) => model !== name);
  }
  isBusy(name: string): boolean {
    return (this.pins.get(name) ?? 0) > 0 || this.busyNames.has(name);
  }
  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }
  isModelReady(name: string): boolean {
    return this.loaded.has(name) && !this.notReady.has(name);
  }
  backendProcesses(): readonly [] {
    return [];
  }
  residencySignature(): string {
    return [...this.loaded.keys()].join(',');
  }
  canDelegate(): DelegationCheck {
    return { ok: true } as DelegationCheck;
  }
  async acquireForDelegation(): Promise<DelegationHold> {
    return { release: async () => {} } as DelegationHold;
  }
  parallelCapacity(): number {
    return 1;
  }
  async prepareExternal(name: string): Promise<void> {
    this.prepareExternalCalls.push(name);
    if (this.prepareExternalError) throw this.prepareExternalError;
    this.loaded.set(name, null);
  }
  pinModel(name: string): () => void {
    this.pinsTaken += 1;
    this.pins.set(name, (this.pins.get(name) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.unpins += 1;
      const count = this.pins.get(name) ?? 0;
      if (count <= 1) this.pins.delete(name);
      else this.pins.set(name, count - 1);
    };
  }
  modelPort(name: string): number | null {
    return this.loaded.get(name) ?? null;
  }
}

/** A `ModelLifecycleContext` with a synchronous chain: enough for
 *  `ensureModelLoaded` to run its real capacity guard and readiness wait. */
export function makeLifecycleContext(
  config: ForgeConfig,
  pool: FakeStarterPool,
): ModelLifecycleContext {
  return {
    config,
    pool: pool as unknown as BackendPool,
    holds: new Map<string, number>(),
    loadingModels: new Set<string>(),
    lastAcquiredAt: new Map<string, number>(),
    probe: async () => true,
    readinessTimeoutMs: 1_000,
    readinessIntervalMs: 1,
    evictionGraceMs: 0,
    resolveBase: (requested: string) => ({ name: requested }),
    serialize: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
}

/** Bind the starter on an ephemeral loopback port and wait for it to answer. */
export async function startStarter(
  config: ForgeConfig,
  pool = new FakeStarterPool(),
): Promise<{
  starter: ModelStarterServer;
  leases: ModelStarterLeases;
  pool: FakeStarterPool;
  port: number;
  close: () => void;
}> {
  const leases = new ModelStarterLeases(
    () => (config.model_starter?.lease_ttl_s ?? 600) * 1000,
  );
  const ctx = makeLifecycleContext(config, pool);
  const controlServer = { lifecycleContext: () => ctx } as unknown as ControlServer;
  const starter = new ModelStarterServer({
    getConfig: () => config,
    pool: pool as unknown as BackendPool,
    controlServer,
    leases,
  });
  starter.applyConfig();
  const address = await waitForBound(starter);
  return { starter, leases, pool, port: address, close: () => starter.dispose() };
}

async function waitForBound(starter: ModelStarterServer): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const address = starter.boundAddress();
    if (address) return address.port;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('model starter did not bind within 1s');
}

export interface StarterResponse {
  status: number;
  text: string;
  body: Record<string, unknown> | undefined;
}

/** One HTTP request against the bound starter, with the headers a laptop would
 *  send — including an explicit `Host`, which is what the rebinding guard reads. */
export function starterRequest(
  port: number,
  request: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Send without `content-length` (chunked), like a streaming client would. */
    chunked?: boolean;
  } = {},
): Promise<StarterResponse> {
  const headers: Record<string, string | number> = { ...request.headers };
  if (request.body !== undefined && !request.chunked) {
    headers['content-length'] = Buffer.byteLength(request.body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: request.method ?? 'GET',
        path: request.path ?? '/',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown> | undefined;
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode ?? 0, text, body });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

/** POST with the content-type the starter requires. */
export function starterPost(
  port: number,
  path: string,
  payload: Record<string, unknown> | string,
  extraHeaders: Record<string, string> = {},
): Promise<StarterResponse> {
  return starterRequest(port, {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

/** Cast helper for tests that need the concrete pool type. */
export const asBackendPool = (pool: FakeStarterPool): BackendPool =>
  pool as unknown as BackendPool;

export const addressInfoOf = (server: http.Server): AddressInfo | null => {
  const address = server.address();
  return address && typeof address !== 'string' ? address : null;
};

/** Wait until `check` says true, polling every 5 ms. How a test reads an event
 *  that arrives asynchronously — a desktop aborting a stream it no longer has a
 *  client for — without depending on how fast this machine is. */
export async function waitForCondition(
  check: () => boolean,
  timeoutMs = 2_000,
): Promise<boolean> {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 5) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

/** One request a fake model server answered, in the order it arrived. */
export interface FakeModelRequest {
  method: string;
  /** The path the model server was asked for, query included: what proves the
   *  pass-through forwarded `/v1/chat/completions` and not
   *  `/<model>/v1/chat/completions`, and that the query survived the trip. */
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeModelServer {
  port: number;
  /** Every request it answered, in order. */
  requests: FakeModelRequest[];
  /** Requests still open — a stream that has not ended. */
  open(): number;
  /** True when a client stopped reading before the answer ended. The
   *  pass-through's own abort has to show up here, because that is the only way
   *  a test can see that the desktop was told to stop generating. */
  sawEarlyClose(): boolean;
  close(): Promise<void>;
}

/**
 * A model server on an ephemeral loopback port that answers like one: JSON for
 * an ordinary request, and an endless `text/event-stream` for a request that
 * asks for `"stream": true` — because what has to be proven about the
 * pass-through is that a stream is not buffered and that a laptop hanging up
 * stops it.
 *
 * Ephemeral ports are deliberate: this machine IS a desktop, with real servers
 * on 8070, 8080-8083 and 8090-8092, so a test that dialed one of those would be
 * testing the owner's running Strata instead of the code under test.
 */
export async function startFakeModelServer(
  behavior: { streamChunkDelayMs?: number; maxStreamChunks?: number } = {},
): Promise<FakeModelServer> {
  const delay = behavior.streamChunkDelayMs ?? 5;
  const maxChunks = behavior.maxStreamChunks ?? 400;
  const requests: FakeModelRequest[] = [];
  let open = 0;
  let earlyCloses = 0;
  const server = http.createServer((req, res) => {
    open += 1;
    let stopTimer: (() => void) | undefined;
    res.on('close', () => {
      open -= 1;
      if (!res.writableEnded) earlyCloses += 1;
      stopTimer?.();
    });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body,
      });
      let wantsStream = false;
      try {
        wantsStream = (JSON.parse(body || '{}') as { stream?: boolean }).stream === true;
      } catch {
        wantsStream = false;
      }
      if (!wantsStream) {
        const answer = JSON.stringify({ object: 'list', data: [{ id: 'fake', object: 'model' }] });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(answer)),
        });
        res.end(answer);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          clearInterval(timer);
          return;
        }
        if (sent >= maxChunks) {
          res.end();
          clearInterval(timer);
          return;
        }
        sent += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${sent}` } }] })}\n\n`);
      }, delay);
      timer.unref?.();
      stopTimer = (): void => clearInterval(timer);
    });
  });
  const port = await listenLoopback(server);
  return {
    port,
    requests,
    open: () => open,
    sawEarlyClose: () => earlyCloses > 0,
    close: () =>
      new Promise<void>((resolve) => {
        (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface StarterStreamHandle {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Wait for at most `maxChunks` chunks of the answer and return them. */
  read(maxChunks: number): Promise<string[]>;
  /** Hang up mid-stream: close the client side of the connection. This is how a
   *  laptop leaves a stream, and the only way a test can show that the desktop
   *  was told to stop generating. */
  hangUp(): void;
  /** Resolves when the answer ends — normally, or because of `hangUp()`. */
  finished: Promise<{ chunks: string[]; endedEarly: boolean }>;
}

/**
 * The pass-through fixture: a desktop starter whose llama.cpp slot range and
 * whose managed-external endpoint are the ephemeral ports of three FAKE model
 * servers, so a test can see exactly which port the starter dialed and which it
 * left alone. `decoy` is the port a laptop might try to smuggle into a request:
 * nothing may ever be dialed there, so its `requests` list staying empty is
 * what proves the port came from the desktop.
 *
 * Neither ephemeral port is in `shared_ports` — that is the point of the
 * pass-through: the model is servable through the starter's own port without
 * its port being shared, and `port_shared` says the direct road is closed.
 */
export async function startPassThroughStarter(): Promise<{
  starter: ModelStarterServer;
  starterPort: number;
  config: ForgeConfig;
  pool: FakeStarterPool;
  leases: ModelStarterLeases;
  /** The port the pool handed the loaded llama.cpp model. */
  slot: FakeModelServer;
  /** The fixed endpoint port of the managed external. */
  external: FakeModelServer;
  decoy: FakeModelServer;
  close: () => Promise<void>;
}> {
  const stream = { maxStreamChunks: 6, streamChunkDelayMs: 5 };
  const slot = await startFakeModelServer(stream);
  const external = await startFakeModelServer(stream);
  const decoy = await startFakeModelServer(stream);
  const config = makeStarterConfig({ port: 0 });
  // The pool range and the external's endpoint become the fake servers' ports,
  // so nothing in these tests can reach the Strata or llama.cpp actually
  // running on this machine.
  config.llama_server = { port: slot.port };
  config.max_simultaneous_models = 1;
  config.models = config.models.map((model) =>
    model.name === 'strata-iq3s' ? { ...model, endpoint: `http://127.0.0.1:${external.port}` } : model,
  );
  const pool = new FakeStarterPool([slot.port]);
  pool.loaded.set('gemma-iq3s', slot.port);
  pool.loaded.set('strata-iq3s', external.port);
  const started = await startStarter(config, pool);
  // In a real desktop config `model_starter.port` IS the port the listener
  // bound, and the pass-through's service-port guard reads that value. Port 0
  // only means "pick one for me" during the bind, so make the config agree with
  // the port it actually got — otherwise a model pointing at the starter's own
  // port would not read as a service port, and the test would be testing a
  // desktop that does not exist.
  config.model_starter!.port = started.port;
  return {
    starter: started.starter,
    starterPort: started.port,
    config,
    pool: started.pool,
    leases: started.leases,
    slot,
    external,
    decoy,
    close: async () => {
      started.close();
      await Promise.all([slot.close(), external.close(), decoy.close()]);
    },
  };
}

/** One request against the bound starter that resolves as soon as the response
 *  HEADERS arrive, so a test can read a stream as it lands and hang up partway
 *  through it. `starterRequest` waits for the whole body, which a stream never
 *  finishes sending on its own. */
export function starterStreamRequest(
  port: number,
  request: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<StarterStreamHandle> {
  const headers: Record<string, string | number> = { ...request.headers };
  if (request.body !== undefined) headers['content-length'] = Buffer.byteLength(request.body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: request.method ?? 'GET',
        path: request.path ?? '/',
        headers,
        agent: false,
      },
      (res) => {
        settled = true;
        const chunks: string[] = [];
        let ended = false;
        const finished = new Promise<{ chunks: string[]; endedEarly: boolean }>((done) => {
          res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
          res.on('end', () => {
            ended = true;
            done({ chunks, endedEarly: false });
          });
          res.on('close', () => done({ chunks, endedEarly: !ended }));
          res.on('error', () => done({ chunks, endedEarly: !ended }));
        });
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          read: async (maxChunks: number) => {
            for (let attempt = 0; chunks.length < maxChunks && !ended; attempt += 1) {
              await new Promise((resolveWait) => setTimeout(resolveWait, 5));
            }
            return chunks.slice(0, maxChunks);
          },
          hangUp: () => res.destroy(),
          finished,
        });
      },
    );
    req.on('error', (error: Error) => {
      if (!settled) reject(error);
    });
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}
