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

export function allocatePort(table: SlotTable, allowEvict: boolean): number {
  if (table.freePorts.length > 0) return table.freePorts.shift()!;
  if (!allowEvict) {
    // Unreachable via DelegationGate (it pre-checks synchronously); kept as
    // a hard guard so a non-evicting acquire can never evict.
    throw new Error('BackendPool: no free slot for a non-evicting acquire');
  }
  const lruEntry = lruSlot(table);
  if (!lruEntry) {
    throw new Error(
      'BackendPool: no free slot and no eviction candidate — all resident models ' +
        'are pinned by active delegation holds. Retry after delegation completes.',
    );
  }
  const [lruModel, slot] = lruEntry;
  log.info(`[BackendPool] evicting LRU slot: ${lruModel} on port ${slot.port}`);
  void slot.backend.stop().catch(() => {});
  table.slots.delete(lruModel);
  return slot.port;
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
