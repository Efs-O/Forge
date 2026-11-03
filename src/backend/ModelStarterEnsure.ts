/**
 * What the model starter can serve, and what `POST /ensure` does about it.
 *
 * Split out of `ModelStarterServer`, which keeps the HTTP surface. Both routes
 * that answer "can a laptop reach this model?" — `GET /models` and
 * `POST /ensure` — go through `remoteServability`, so they can never disagree:
 * a model `/models` marks `remote: false` is refused by `/ensure` with the same
 * reason, and `/ensure` never evicts anything on a model it will not serve.
 *
 * Loading itself is reused, not reimplemented: llama.cpp goes through
 * `ensureModelLoaded` (capacity guard, readiness wait, hold) and managed
 * externals through `BackendPool.prepareExternal` (free VRAM, single-flight
 * start, mark in use). The starter adds only the pin and the lease on top.
 */

import {
  ensureModelLoaded,
  releaseHold,
  type ModelLifecycleContext,
} from './ControlModelLifecycle';
import type { EnsureResult } from './ControlServer';
import { ExternalBusyError } from './poolAcquisition';
import { isManagedExternalModel } from './ExternalModelServers';
import { deriveStaticCapabilities, mergeGroupsIntoModel } from '../config/ConfigResolver';
import { perSlotContext } from '../util/contextBudget';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { ModelStarterConfig } from '../config/modelStarterSchema';
import type { ModelStarterLeases, RemoteLease, RemoteModelKind } from './ModelStarterLeases';
import { errText } from './controlHttp';

/** Why a model cannot be started or reached from the laptop.
 *  `port_not_shared` is now the narrow case it always really was — a model with
 *  no port at all to use — because the pass-through made "is the port shared"
 *  a question about the OLD direct-dial route rather than about reachability.
 *  `service_port` is the new one: a model entry can name a port Forge listens
 *  on itself, and forwarding a laptop's model traffic into the control server,
 *  the cloud relay, the starter's own surface or Ollama's daemon is not serving
 *  a model. */
export type RemoteReason =
  | 'not_local'
  | 'ollama_not_shared'
  | 'cli_agent'
  | 'port_not_shared'
  | 'service_port';

export interface RemoteServability {
  remote: boolean;
  /** What `POST /ensure` would have to do to serve it, or null when nothing. */
  kind: RemoteModelKind | null;
  /** The fixed port a laptop reaches it on — managed externals only. A
   *  llama.cpp slot port is assigned by the load, so `/ensure` reports it. */
  port: number | null;
  /** True when the model's own port is in `model_starter.shared_ports`: the
   *  port is directly shared, so a laptop entry that DIALS it (the shape every
   *  `remote_start` entry had before the pass-through) still reaches it.
   *  This no longer decides `remote` — a model whose port nobody shares is
   *  still servable, because its traffic comes through the starter's own shared
   *  port — but it is what tells an old entry whether its route still exists,
   *  and `GET /models` reports it as `port_shared` for exactly that use. */
  port_shared: boolean;
  reason?: RemoteReason;
}

/** The pool decisions the starter needs. `BackendPool` satisfies it; the
 *  `modelPort` half is optional so a test fake can skip it. */
export interface StarterPool {
  /** Free VRAM for a managed external and start its server if it is down. */
  prepareExternal(modelName: string): Promise<void>;
  /** Pin until the returned function is called once — the lease's protection. */
  pinModel(modelName: string): () => void;
  isBusy(modelName: string): boolean;
  isModelReady(modelName: string): boolean;
  loadedModelNames(): string[];
  modelPort?(modelName: string): number | null;
}

export interface EnsureOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** The ports Forge listens on itself, plus Ollama's daemon port. A model entry
 *  CAN name one of them — `endpoint: http://127.0.0.1:8797` is a perfectly good
 *  URL — so the check belongs here, where the forwarding port is decided:
 *  forwarding a laptop's model request into the control server, the cloud relay,
 *  the starter's own four-route surface (a forward to it is a loop) or an
 *  unbounded Ollama daemon is not serving a model, and the laptop would get an
 *  answer from something that is not its model. */
export function forgeServicePorts(config: ForgeConfig, starter: ModelStarterConfig): Set<number> {
  return new Set([
    config.control_server?.port ?? 8799,
    config.cloud_relay?.port ?? 8797,
    starter.port,
    OLLAMA_DAEMON_PORT,
  ]);
}

/** Ollama's default daemon port: the port a laptop reaches when it says
 *  `localhost:11434`, so a desktop entry pointing at it must not be served as a
 *  model either (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md, "Which models are
 *  remotely servable"). */
const OLLAMA_DAEMON_PORT = 11434;

/**
 * `model` must already be group-resolved: `provider` and `endpoint` are
 * routinely inherited from a `group`, and reading the raw entry would classify
 * every group-inherited model as llama.cpp (the defect ControlModelCatalog
 * .entryFor fixed).
 *
 * `remote` is the pass-through's target set: every model marked true here is
 * one the starter will forward model traffic to, and every one marked false is
 * refused before a byte is dialed. It no longer asks whether the model's own
 * port is shared — that question belonged to the direct-dial route, and the
 * pass-through made it optional — but the answer is still reported, as
 * `port_shared`, because old laptop entries dial the model port directly and
 * have to be told whether that road is still open.
 */
export function remoteServability(
  model: ModelConfig,
  config: ForgeConfig,
  starter: ModelStarterConfig,
): RemoteServability {
  const provider = model.provider ?? 'llama.cpp';
  const servicePorts = forgeServicePorts(config, starter);
  const shared = (port: number | null): boolean =>
    port !== null && starter.shared_ports.includes(port);
  if (provider === 'cli') {
    return { remote: false, kind: null, port: null, port_shared: false, reason: 'cli_agent' };
  }
  // Ollama is daemon-backed and unbounded: a laptop asking for it would reach
  // its own daemon, not this machine's, and the pass-through must not put the
  // desktop's daemon in front of a laptop that meant its own.
  if (provider === 'ollama') {
    return {
      remote: false,
      kind: null,
      port: null,
      port_shared: false,
      reason: 'ollama_not_shared',
    };
  }
  if (provider === 'xai' || provider === 'openrouter' || provider === 'openai') {
    return { remote: false, kind: null, port: null, port_shared: false, reason: 'not_local' };
  }
  if (provider === 'openai-compatible') {
    // A managed external (unload_path) is a local server this window can start
    // and free. An unmanaged one is a hand-started endpoint the laptop can
    // already reach directly — starting it from here would be a guess.
    if (!isManagedExternalModel(model)) {
      return {
        remote: false,
        kind: null,
        port: null,
        port_shared: false,
        reason: 'not_local',
      };
    }
    const port = endpointPort(model.endpoint);
    // No port at all: nothing to dial directly and nothing to forward to, which
    // is the one case `port_not_shared` still names.
    if (port === null) {
      return {
        remote: false,
        kind: null,
        port: null,
        port_shared: false,
        reason: 'port_not_shared',
      };
    }
    if (servicePorts.has(port)) {
      return {
        remote: false,
        kind: null,
        port: null,
        port_shared: false,
        reason: 'service_port',
      };
    }
    return { remote: true, kind: 'managed-external', port, port_shared: shared(port) };
  }
  // llama.cpp: the pool hands out `llama_server.port` .. `+ max - 1` in whatever
  // order slots free up. Before the pass-through every one of those had to be
  // shared or the laptop timed out on the slot it had not shared; now the laptop
  // comes in through the starter's own port and the slot is reached on loopback,
  // so the range only has to stay clear of Forge's service ports.
  const base = config.llama_server.port ?? 8080;
  const count = config.max_simultaneous_models ?? 1;
  const slots = Array.from({ length: count }, (_, index) => base + index);
  if (slots.some((port) => servicePorts.has(port))) {
    return {
      remote: false,
      kind: null,
      port: null,
      port_shared: false,
      reason: 'service_port',
    };
  }
  const allSlotsShared = slots.every((port) => starter.shared_ports.includes(port));
  return { remote: true, kind: 'llama.cpp', port: null, port_shared: allSlotsShared };
}

/** One entry of `GET /models`. `context` is what the laptop must set `num_ctx`
 *  to: `perSlotContext` for llama.cpp (which divides by `n_parallel`), and the
 *  configured `num_ctx` for a server this window does not spawn. */
export function buildStarterModelEntry(
  model: ModelConfig,
  deps: {
    config: ForgeConfig;
    starter: ModelStarterConfig;
    pool: StarterPool & { isLoaded(modelName: string): boolean };
    leases: ModelStarterLeases;
  },
): Record<string, unknown> {
  const resolved = mergeGroupsIntoModel(deps.config, model);
  const servability = remoteServability(resolved, deps.config, deps.starter);
  const port =
    servability.kind === 'managed-external'
      ? servability.port
      : servability.kind === 'llama.cpp'
        ? (deps.pool.modelPort?.(model.name) ?? null)
        : null;
  return {
    name: model.name,
    display_name: model.display_name ?? model.name,
    kind: servability.kind,
    port,
    context: perSlotContext(resolved, deps.config.llama_server, resolved.provider ?? 'llama.cpp'),
    capabilities: deriveStaticCapabilities(resolved),
    loaded: deps.pool.isLoaded(model.name),
    leasedBy: deps.leases.clientsFor(model.name),
    remote: servability.remote,
    // Whether this model's own port is directly shared, so a laptop that has to
    // fall back to dialing it knows whether that road is open.
    port_shared: servability.port_shared,
    // The three fields a laptop cannot guess and did not used to get: the served
    // id, the tokenizer and the reasoning default. Fields, not routes, so
    // `ModelStarterSurface.test.ts`'s locked surface is untouched.
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.token_count ? { token_count: resolved.token_count } : {}),
    ...(resolved.reasoning_effort ? { reasoning_effort: resolved.reasoning_effort } : {}),
    ...(servability.reason ? { reason: servability.reason } : {}),
  };
}

/**
 * `POST /ensure`: make this model answer, and hold it. Runs on the control
 * server's chain, so a remote ensure and a `POST /ensure` from :8799 cannot
 * both `makeRoom` and both spawn.
 *
 * Renewal does NOT reload: re-running `ensureModelLoaded` for every heartbeat
 * would take a second hold each time, and the lease could only ever release
 * one. A lease implies the model was loaded and pinned here, so while it is
 * still ready the lease is simply pushed out; when it is not, the cached port
 * is stale and the lease is dropped and re-earned.
 */
export async function ensureForRemote(deps: {
  ctx: ModelLifecycleContext;
  pool: StarterPool;
  leases: ModelStarterLeases;
  client: string;
  /** Already resolved to a base config model name by the route. */
  model: string;
  servability: RemoteServability;
}): Promise<EnsureOutcome> {
  const { ctx, pool, leases, client, model, servability } = deps;
  return ctx.serialize(async () => {
    const held = leases.find(client, model);
    if (held) {
      if (pool.isModelReady(model)) return { status: 200, body: leaseBody(leases.renew(held)) };
      // The server died, or something outside this window unloaded it: the
      // port this lease names is no longer an answer. Re-earn it.
      leases.release(held);
    }
    // Switching models frees the laptop's own previous model FIRST. Held to
    // its old lease, that model would read as busy and `freeVramForExternal`
    // would refuse the switch the laptop is making.
    leases.releaseClientExcept(client, model);
    const unpin = pool.pinModel(model);
    let holdTaken = false;
    let stored = false;
    const teardown = () => {
      unpin();
      if (holdTaken) releaseHold(ctx, model);
    };
    try {
      let port: number;
      let kind: RemoteModelKind;
      if (servability.kind === 'managed-external') {
        try {
          await pool.prepareExternal(model);
        } catch (err) {
          return errorToOutcome(err);
        }
        if (servability.port === null) {
          return { status: 422, body: { error: `"${model}" has no port to report` } };
        }
        port = servability.port;
        kind = 'managed-external';
      } else {
        const result = await ensureModelLoaded(ctx, model);
        if (result.status !== 200) return ensureRefusalToOutcome(result, pool);
        holdTaken = true;
        const loadedPort = portFromBaseUrl((result.body as { baseUrl: string }).baseUrl);
        if (loadedPort === null) {
          return {
            status: 502,
            body: {
              error: `"${model}" loaded but its port could not be read from ${String(
                (result.body as { baseUrl: string }).baseUrl,
              )}`,
            },
          };
        }
        port = loadedPort;
        kind = 'llama.cpp';
      }
      const lease = leases.grant({ client, model, port, kind, release: teardown });
      stored = true;
      return { status: 200, body: leaseBody(lease) };
    } finally {
      // The ledger's dangerous cell: failing after the pin but before the lease
      // is stored must still unpin, or the model stays protected with nothing
      // holding it. `teardown` is idempotent, so a stored lease can never be
      // released twice by this path.
      if (!stored) teardown();
    }
  });
}

/** A refusal from `ensureModelLoaded`, given the names that caused it: the
 *  control server's capacity 409 does not carry them, so the loaded-and-in-use
 *  set is read off the pool here. The :8799 response shape is left alone —
 *  `busyModel` is added only on the starter's own surface. */
function ensureRefusalToOutcome(result: EnsureResult, pool: StarterPool): EnsureOutcome {
  const body: Record<string, unknown> = { ...(result.body as Record<string, unknown>) };
  if (result.status === 409) body.busyModel = busyNames(pool);
  return { status: result.status, body };
}

/** A thrown failure: the pool-side busy refusal becomes 409 with the models
 *  that blocked it, everything else is a 502 with the desktop's own error text
 *  — no silent fallback, the laptop shows what the desktop said. */
function errorToOutcome(err: unknown): EnsureOutcome {
  if (err instanceof ExternalBusyError) {
    return {
      status: 409,
      body: { error: err.message, busyModel: [...err.busyModels] },
    };
  }
  return { status: 502, body: { error: errText(err) } };
}

function busyNames(pool: StarterPool): string[] {
  return pool.loadedModelNames().filter((name) => pool.isBusy(name));
}

function leaseBody(lease: RemoteLease): Record<string, unknown> {
  return {
    model: lease.model,
    port: lease.port,
    leaseId: lease.id,
    expiresAt: lease.expiresAt,
    kind: lease.kind,
  };
}

function endpointPort(endpoint: string | undefined): number | null {
  if (!endpoint) return null;
  try {
    return portOf(new URL(endpoint));
  } catch {
    return null;
  }
}

function portFromBaseUrl(baseUrl: string): number | null {
  try {
    return portOf(new URL(baseUrl));
  } catch {
    return null;
  }
}

function portOf(url: URL): number | null {
  const port = Number(url.port);
  if (Number.isInteger(port) && port > 0) return port;
  return url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : null;
}
