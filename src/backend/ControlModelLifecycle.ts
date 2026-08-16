/**
 * Loading, capacity, and teardown for control-server models.
 *
 * Split out of `ControlServer`, which keeps the HTTP surface. The rules here
 * are about VRAM rather than requests: what may be evicted, how long a freshly
 * acquired model is protected, and when a load is refused outright.
 */

import type { IBackendPool } from './BackendPool';
import type { ForgeConfig } from '../config/types';
import { isCloudProvider, getCloudProviderLabel } from '../llm/CloudProviders';
import { delay, toOpenAiBase, errText } from './controlHttp';
import { getLogger } from '../util/logger';
import type { EnsureResult } from './ControlServer';

const log = getLogger();

/** The mutable state the lifecycle operations share with the server. */
export interface ModelLifecycleContext {
  config: ForgeConfig;
  pool: IBackendPool;
  /** model → number of outstanding /ensure holds. */
  holds: Map<string, number>;
  /** Models currently being loaded, for the /models catalog. */
  loadingModels: Set<string>;
  lastAcquiredAt: Map<string, number>;
  probe: (baseUrl: string) => Promise<boolean>;
  readinessTimeoutMs: number;
  readinessIntervalMs: number;
  evictionGraceMs: number;
  /** Resolves an alias/@profile/fuzzy id to a base model name. */
  resolveBase: (requested: string) => { name: string } | EnsureResult;
}

export async function ensureModelLoaded(
  ctx: ModelLifecycleContext,
  requested: string,
): Promise<EnsureResult> {
  // Profiles never change which GGUF is loaded — resolve to the base model
  // for all loading/capacity bookkeeping (F6). Fuzzy/short names resolve here too.
  const resolved = ctx.resolveBase(requested);
  if (!('name' in resolved)) return resolved;
  const model = resolved.name;
  const known = ctx.config.models.find((m) => m.name === model);
  if (!known) {
    return { status: 404, body: { error: `unknown model "${requested}" — not in config` } };
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
    const guard = await makeRoom(ctx, model);
    if (guard) return guard;
  }

  ctx.loadingModels.add(model);
  try {
    const backend = await ctx.pool.acquire(model);
    // Readiness gate: the process can be spawned but not yet accepting HTTP
    // (a cold 26B takes ~30 s). Returning a baseUrl before the backend serves
    // is what lets a consumer's immediate POST hit ECONNRESET. llama.cpp only —
    // Ollama is daemon-backed and already serving when acquire resolves.
    if (!isOllama && !(await waitReady(ctx, backend.baseUrl()))) {
      return {
        status: 502,
        body: {
          error: `"${model}" loaded but not ready: no HTTP response within ${ctx.readinessTimeoutMs}ms`,
        },
      };
    }
    ctx.holds.set(model, (ctx.holds.get(model) ?? 0) + 1);
    ctx.lastAcquiredAt.set(model, Date.now());
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
  } finally {
    ctx.loadingModels.delete(model);
  }
}

/** Poll the backend until it answers an HTTP request or the timeout elapses. */
async function waitReady(ctx: ModelLifecycleContext, baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + ctx.readinessTimeoutMs;
  for (;;) {
    if (await ctx.probe(baseUrl)) return true;
    if (Date.now() >= deadline) return false;
    await delay(ctx.readinessIntervalMs);
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
async function makeRoom(ctx: ModelLifecycleContext, model: string): Promise<EnsureResult | null> {
  const loaded = ctx.pool.loadedModelNames();
  if (loaded.includes(model)) return null;

  const now = Date.now();
  const idle = loaded.filter(
    (m) =>
      (ctx.holds.get(m) ?? 0) === 0 &&
      now - (ctx.lastAcquiredAt.get(m) ?? 0) >= ctx.evictionGraceMs,
  );
  for (const victim of idle) {
    ctx.lastAcquiredAt.delete(victim);
    // Await each release: it frees the slot/port only after backend.stop()
    // resolves. Fire-and-forget here let the subsequent acquire race it —
    // allocatePort would LRU-evict the same slot and reuse its port, then the
    // in-flight release pushed that port back while the new slot occupied it.
    await ctx.pool.release(victim);
    log.info(`[ControlServer] released idle "${victim}" to make room for "${model}"`);
  }

  const remaining = loaded.length - idle.length;
  const capacity = ctx.config.max_simultaneous_models ?? 1;
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

/** Release a hold on an already-resolved base model name. Fuzzy/alias/@profile
 *  resolution happens once in `resolveBase` at the route boundary — this
 *  never re-resolves, so it stays pure bookkeeping. */
export function releaseHold(ctx: ModelLifecycleContext, model: string): boolean {
  const current = ctx.holds.get(model) ?? 0;
  if (current <= 0) return false;
  const next = current - 1;
  if (next === 0) ctx.holds.delete(model);
  else ctx.holds.set(model, next);
  return true;
}

/** Eager teardown (POST /unload): refuses while holds exist; otherwise stops
 *  the backend and frees its VRAM/slot. `release` stays pure bookkeeping. */
export async function unloadModel(
  ctx: ModelLifecycleContext,
  requested: string,
): Promise<EnsureResult | { status: number; body: { unloaded: boolean } }> {
  const resolved = ctx.resolveBase(requested);
  if (!('name' in resolved)) return resolved;
  const model = resolved.name;
  const known = ctx.config.models.find((m) => m.name === model);
  if (!known) {
    return { status: 404, body: { error: `unknown model "${requested}" — not in config` } };
  }
  if (isCloudProvider(known.provider)) {
    return {
      status: 422,
      body: { error: `"${model}" is a cloud-provider model — nothing local to unload` },
    };
  }
  if ((ctx.holds.get(model) ?? 0) > 0) {
    return {
      status: 409,
      body: { error: `"${model}" has active holds — POST /release them first` },
    };
  }
  const wasLoaded = ctx.pool.isLoaded(model);
  ctx.lastAcquiredAt.delete(model);
  await ctx.pool.release(model);
  if (wasLoaded) log.info(`[ControlServer] unloaded "${model}"`);
  return { status: 200, body: { unloaded: wasLoaded } };
}
