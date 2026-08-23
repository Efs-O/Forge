/**
 * The two acquisition paths that do not own a llama.cpp slot: an Ollama model
 * served by the local daemon, and a llama-server already running elsewhere that
 * this window can borrow.
 *
 * Split out of `BackendPool`, which keeps slot allocation and eviction —
 * neither of these consumes a port or competes for one.
 */

import type { BackendController } from './BackendController';
import { DirectBackend } from './DirectBackend';
import { probeHealthy } from './HealthCheck';
import type { ForgeConfig } from '../config/types';
import type { SharedRuntimeRegistry } from './SharedRuntimeRegistry';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface SharedSlotRecord {
  backend: DirectBackend;
  key: string;
  leaseId: string;
}

export interface SharedRuntimeContext {
  config: ForgeConfig;
  registry: SharedRuntimeRegistry;
  key: string;
}

/** Reuses a healthy llama-server published by another window, under a lease. */
export async function borrowSharedRuntime(
  ctx: SharedRuntimeContext,
  modelName: string,
  onBorrowed: (record: SharedSlotRecord) => void,
): Promise<BackendController | undefined> {
  const record = ctx.registry.find(ctx.key);
  if (!record || !(await probeHealthy(record.endpoint))) return undefined;
  const port = Number(new URL(record.endpoint).port);
  if (!Number.isInteger(port) || port < 1) return undefined;
  const backend = new DirectBackend(ctx.config, port);
  await backend.hotSwap(modelName);
  const leaseId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ctx.registry.acquireLease(ctx.key, leaseId);
  onBorrowed({ backend, key: ctx.key, leaseId });
  log.info(`[BackendPool] borrowed shared runtime: ${modelName} at ${record.endpoint}`);
  return backend;
}

export interface OllamaSlotContext {
  config: ForgeConfig;
  slots: Map<string, DirectBackend>;
  starting: Map<string, Promise<BackendController>>;
}

export function acquireOllamaSlot(
  ctx: OllamaSlotContext,
  modelName: string,
): Promise<BackendController> {
  const inFlight = ctx.starting.get(modelName);
  if (inFlight) return inFlight;

  const existing = ctx.slots.get(modelName);

  const start = (async (): Promise<BackendController> => {
    // `isReady` can be stale: the daemon may have died since the last use.
    // Re-verify before trusting the cached slot; a dead endpoint falls
    // through to hotSwap, which re-ensures (and may auto-start) the daemon.
    if (existing?.isReady() && (await probeHealthy(existing.baseUrl()))) {
      return existing;
    }
    if (existing) {
      // Stale or never finished — re-hotSwap without recreating
      await existing.hotSwap(modelName);
      return existing;
    }
    // Port is irrelevant for Ollama: DirectBackend.hotSwap overrides currentBaseUrl
    // to model.endpoint, so the port value here is never used.
    const backend = new DirectBackend(ctx.config, 0);
    ctx.slots.set(modelName, backend);
    await backend.hotSwap(modelName);
    log.info(`[BackendPool] ollama slot ready: ${modelName}`);
    return backend;
  })();
  ctx.starting.set(modelName, start);
  return start.finally(() => ctx.starting.delete(modelName));
}

export interface StopAllContext {
  slots: Map<string, { backend: DirectBackend; starting: Promise<void> | null }>;
  ollamaSlots: Map<string, DirectBackend>;
  sharedSlots: Map<string, SharedSlotRecord>;
  registry: SharedRuntimeRegistry;
  sharedRuntimeEnabled: boolean;
  runtimeKey: (modelName: string) => string;
}

/**
 * Stops everything this window owns. A runtime another window still borrows is
 * deliberately left running — the last borrower's release tears it down.
 */
export async function stopAllSlots(ctx: StopAllContext): Promise<void> {
  for (const [model, shared] of ctx.sharedSlots) {
    // detach(), never stop(): the process belongs to another window. stop()
    // does refuse an adopted server, but only by throwing from deep inside
    // stopLlamaServer — so the safety here would rest entirely on a swallowed
    // exception, and it would also skip resetAttachmentState and leave the
    // backend half-torn-down. Make the borrower path explicit instead.
    try {
      await shared.backend.detach();
    } finally {
      ctx.registry.releaseLease(shared.key, shared.leaseId);
      ctx.sharedSlots.delete(model);
    }
  }
  const retained = (model: string): boolean =>
    ctx.sharedRuntimeEnabled && ctx.registry.hasBorrowers(ctx.runtimeKey(model));

  const slotStops = [...ctx.slots.entries()].map(async ([model, slot]) => {
    if (retained(model)) {
      log.info(`[BackendPool] retained shared runtime: ${model}`);
      return;
    }
    if (slot.starting) await slot.starting.catch(() => {});
    await slot.backend.stop();
  });
  const ollamaStops = [...ctx.ollamaSlots.values()].map(async (backend) => {
    try {
      await backend.stop();
    } catch {
      /* best-effort */
    }
  });
  const results = await Promise.allSettled([...slotStops, ...ollamaStops]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) =>
      result.reason instanceof Error ? result.reason.message : String(result.reason),
    );
  if (failures.length) throw new Error(failures.join('\n'));

  for (const model of [...ctx.slots.keys()]) {
    if (retained(model)) continue;
    ctx.registry.removeOwner(ctx.runtimeKey(model));
    ctx.slots.delete(model);
  }
  ctx.ollamaSlots.clear();
  log.info('[BackendPool] all slots stopped');
}
