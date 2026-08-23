/**
 * Bringing a llama.cpp slot up: first boot, restart after a crash, and the
 * reconcile that frees a slot whose process died on its own.
 *
 * Split out of `BackendPool`, which keeps the slot table, ports, releases and
 * config policy. The pool passes its state in through `SlotStartContext` on
 * every call — `config` in particular must be read at call time, since a hot
 * reload replaces it.
 */

import type { BackendController } from './BackendController';
import { DirectBackend } from './DirectBackend';
import type { ForgeConfig } from '../config/types';
import type { SharedRuntimeRegistry } from './SharedRuntimeRegistry';
import type { PoolSlot, PortClaim } from './poolSlots';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface SlotStartContext {
  config: ForgeConfig;
  slots: Map<string, PoolSlot>;
  registry: SharedRuntimeRegistry;
  /** Identity this model's server publishes for other windows to borrow. */
  runtimeKey: (modelName: string) => string;
  /** The backend died without Forge stopping it. */
  onUnexpectedExit: (modelName: string) => void;
  freeSlot: (modelName: string, slot: PoolSlot) => void;
  onAcquired: (modelName: string) => void;
}

/** Claim a port, spawn a server into it, and publish it for sharing. */
export function startSlot(
  ctx: SlotStartContext,
  modelName: string,
  claim: PortClaim,
): Promise<BackendController> {
  const { port, evicted } = claim;
  const backend = new DirectBackend(ctx.config, port);
  let resolveStart!: () => void;
  backend.onUnexpectedExit(() => ctx.onUnexpectedExit(modelName));
  let rejectStart!: (err: unknown) => void;
  const starting = new Promise<void>((res, rej) => {
    resolveStart = res;
    rejectStart = rej;
  });
  const slot: PoolSlot = { backend, port, lastUsed: Date.now(), starting };
  ctx.slots.set(modelName, slot);

  // An evicted llama-server holds its VRAM and port until the process is gone,
  // so its teardown must finish before the replacement spawns — fire-and-forget
  // raced the two loads and OOM'd the GPU. The slot above is already registered,
  // so a concurrent acquire joins this boot instead of starting a second one.
  // With nothing to evict, hotSwap must still start synchronously.
  const swapped = evicted
    ? evicted.backend
        .stop()
        .catch(() => {})
        .then(() => backend.hotSwap(modelName))
    : backend.hotSwap(modelName);

  const boot = swapped
    .then(() => {
      slot.starting = null;
      slot.lastUsed = Date.now();
      ctx.onAcquired(modelName);
      if (ctx.config.shared_runtime?.enabled) {
        ctx.registry.publish({
          key: ctx.runtimeKey(modelName),
          model: modelName,
          endpoint: backend.baseUrl(),
          ownerPid: process.pid,
          createdAt: new Date().toISOString(),
        });
      }
      resolveStart();
      log.info(`[BackendPool] slot ready: ${modelName} on port ${port}`);
    })
    .catch((err: unknown) => {
      ctx.freeSlot(modelName, slot);
      rejectStart(err);
    });

  void boot;
  return starting.then(() => backend);
}

/** Reload a model into a slot whose server died, reusing its existing port. */
export async function restartSlot(
  ctx: SlotStartContext,
  modelName: string,
  slot: PoolSlot,
): Promise<BackendController> {
  log.info(`[BackendPool] restarting crashed slot: ${modelName} on port ${slot.port}`);
  let resolveStart!: () => void;
  let rejectStart!: (err: unknown) => void;
  slot.starting = new Promise<void>((res, rej) => {
    resolveStart = res;
    rejectStart = rej;
  });
  try {
    await slot.backend.hotSwap(modelName);
    slot.starting = null;
    slot.lastUsed = Date.now();
    ctx.onAcquired(modelName);
    resolveStart();
    return slot.backend;
  } catch (err) {
    ctx.freeSlot(modelName, slot);
    rejectStart(err);
    throw err;
  }
}

/**
 * A ready backend's process died without Forge stopping it (external kill,
 * crash). Free the slot so /models and capacity decisions reflect reality
 * (docs/archive/validation/RELAY_SMOKE_FINDINGS.md F5). Skipped while a restart
 * is in flight — restartSlot owns the slot during `starting` and frees it
 * itself on failure.
 */
export function reconcileDeadSlot(ctx: SlotStartContext, modelName: string): void {
  const slot = ctx.slots.get(modelName);
  if (!slot || slot.starting) return;
  log.warn(`[BackendPool] backend for "${modelName}" died — freeing slot on port ${slot.port}`);
  ctx.freeSlot(modelName, slot);
}
