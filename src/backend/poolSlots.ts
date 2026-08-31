/**
 * The llama.cpp slot table: which model holds which port, which slot may be
 * evicted, and returning a port to the free list exactly once.
 *
 * Split out of `BackendPool`. Double-freeing a port is the failure this file
 * exists to prevent — two models spawning on the same port fail in ways that
 * look like a backend bug.
 */

import type { DirectBackend } from './DirectBackend';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface PoolSlot {
  backend: DirectBackend;
  port: number;
  lastUsed: number;
  /** Resolves when the slot finishes starting up; null when already ready. */
  starting: Promise<void> | null;
}

export interface SlotTable {
  slots: Map<string, PoolSlot>;
  freePorts: number[];
  /** Models held by an active delegation are never eviction candidates. */
  isPinned: (modelName: string) => boolean;
}

export interface PortClaim {
  port: number;
  /**
   * The evicted slot, when this claim reused its port. Its llama-server is
   * still alive and still holding that VRAM and that port: the caller MUST
   * await `evicted.backend.stop()` before spawning on `port`.
   */
  evicted: PoolSlot | null;
}

/**
 * Claim a port, evicting the LRU slot if none is free. Synchronous by
 * contract — DelegationGate's capacity check must stay valid through the slot
 * claim, so nothing here may await.
 */
export function claimPort(table: SlotTable, allowEvict: boolean): PortClaim {
  if (table.freePorts.length > 0) return { port: table.freePorts.shift()!, evicted: null };
  if (!allowEvict) {
    // Unreachable via DelegationGate (it pre-checks synchronously); kept as
    // a hard guard so a non-evicting acquire can never evict.
    throw new Error('BackendPool: no free slot for a non-evicting acquire');
  }
  const lruEntry = lruSlot(table);
  if (!lruEntry) {
    // Two very different states reach here, and conflating them sent a real
    // port-leak investigation hunting delegation for hours. An empty slot table
    // with no free ports is never a capacity problem — it is a bookkeeping bug.
    if (table.slots.size === 0) {
      throw new Error(
        'BackendPool: no free port and no resident model to evict — the pool has ' +
          'leaked its ports. This is a Forge bug; reload the window to recover ' +
          'and report it.',
      );
    }
    throw new Error(
      'BackendPool: no free slot and no eviction candidate — all resident models ' +
        'are pinned by active delegation holds. Retry after delegation completes.',
    );
  }
  const [lruModel, slot] = lruEntry;
  log.info(`[BackendPool] evicting LRU slot: ${lruModel} on port ${slot.port}`);
  table.slots.delete(lruModel);
  return { port: slot.port, evicted: slot };
}

/**
 * Remove a slot and return its port to the free list — only if `slot` still
 * owns the map entry. A failed boot, an LRU eviction, or a concurrent release
 * may have freed it already while a caller was awaiting; pushing the port twice
 * would let two future models spawn on the same port.
 */
export function freeSlot(table: SlotTable, modelName: string, slot: PoolSlot): void {
  if (table.slots.get(modelName) !== slot) return;
  table.slots.delete(modelName);
  table.freePorts.push(slot.port);
}

export function lruSlot(table: SlotTable): [string, PoolSlot] | undefined {
  let lru: [string, PoolSlot] | undefined;
  for (const entry of table.slots.entries()) {
    if (table.isPinned(entry[0])) continue;
    if (!lru || entry[1].lastUsed < lru[1].lastUsed) lru = entry;
  }
  return lru;
}

export function mostRecentSlot(slots: Map<string, PoolSlot>): PoolSlot | undefined {
  let recent: PoolSlot | undefined;
  for (const slot of slots.values()) {
    if (!recent || slot.lastUsed > recent.lastUsed) recent = slot;
  }
  return recent;
}
