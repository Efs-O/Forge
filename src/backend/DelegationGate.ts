import type { BackendController } from './BackendController';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface DelegationCheck {
  safe: boolean;
  reason?: string;
  /** Ollama targets: the daemon owns VRAM, so non-eviction cannot be
   *  guaranteed — delegation proceeds best-effort (plan: "Ollama targets"). */
  bestEffort?: boolean;
}

export interface DelegationHold {
  backend: BackendController;
  /** Pool key (base model name) of the delegation target. */
  targetKey: string;
  /** True for daemon-backed (Ollama) targets, where the daemon owns VRAM and
   *  non-eviction on the target side cannot be guaranteed. */
  bestEffort: boolean;
  /** Unpin this hold. Idempotent — extra calls are no-ops. Never stops a
   *  backend: another request may still be using it; resident models are
   *  reclaimed by normal LRU eviction once no hold pins them. */
  release(): void;
}

/**
 * Narrow view of BackendPool that the gate operates through. Alias and
 * model@profile normalization stay owned by ConfigResolver/BackendPool
 * (plan A1) — the gate only ever sees and produces pool keys via poolKey().
 */
export interface DelegationPoolOps {
  poolKey(modelName: string): string;
  isOllama(key: string): boolean;
  hasSlot(key: string): boolean;
  freeSlotCount(): number;
  maxSlots(): number;
  /** Acquire that never evicts: claims a free slot synchronously (throws if
   *  none), then boots asynchronously. `key` is already a pool key. */
  acquireNonEvicting(key: string): Promise<BackendController>;
}

/**
 * Owns delegation safety for BackendPool: the read-only capacity check
 * (canDelegate) and the atomic check+acquire hold operation that closes the
 * TOCTOU race between checking capacity and acquiring the target — a
 * concurrent acquire() could otherwise LRU-evict the active primary between
 * the two calls. While a hold is live, both the primary and target pool keys
 * are pinned and BackendPool's LRU eviction skips them.
 */
export class DelegationGate {
  /** pool key → number of live holds pinning it against LRU eviction. */
  private readonly pins = new Map<string, number>();

  constructor(private readonly ops: DelegationPoolOps) {}

  isPinned(key: string): boolean {
    return (this.pins.get(key) ?? 0) > 0;
  }

  check(primaryModel: string, targetModel: string): DelegationCheck {
    const primaryKey = this.ops.poolKey(primaryModel);
    const targetKey = this.ops.poolKey(targetModel);

    if (primaryKey === targetKey) return { safe: true };
    if (this.ops.isOllama(targetKey)) return { safe: true, bestEffort: true };
    if (this.ops.hasSlot(targetKey) || this.ops.freeSlotCount() > 0) return { safe: true };

    return { safe: false, reason: this.noFreeSlotReason(targetKey) };
  }

  /**
   * Atomically check capacity and acquire the target without evicting
   * anything. Pins primary + target for the life of the returned hold so a
   * concurrent acquire() cannot LRU-evict either. The check, the pins, and
   * the slot claim inside acquireNonEvicting all run in the same synchronous
   * segment, so no interleaved acquire can invalidate the check. Throws (and
   * unpins) on capacity or boot failure; the caller must release() the hold
   * exactly once on success, cancellation, and failure paths alike (extra
   * releases are safe no-ops).
   */
  async acquire(primaryModel: string, targetModel: string): Promise<DelegationHold> {
    const primaryKey = this.ops.poolKey(primaryModel);
    const targetKey = this.ops.poolKey(targetModel);
    const bestEffort = this.ops.isOllama(targetKey);
    const keys = primaryKey === targetKey ? [primaryKey] : [primaryKey, targetKey];

    if (
      !bestEffort &&
      targetKey !== primaryKey &&
      !this.ops.hasSlot(targetKey) &&
      this.ops.freeSlotCount() === 0
    ) {
      throw new Error(this.noFreeSlotReason(targetKey));
    }

    for (const key of keys) this.pin(key);
    try {
      const backend = await this.ops.acquireNonEvicting(targetKey);
      log.info(`[DelegationGate] hold acquired: ${targetKey} (primary: ${primaryKey})`);
      return this.makeHold(backend, keys, targetKey, bestEffort);
    } catch (err) {
      for (const key of keys) this.unpin(key);
      if (bestEffort) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Ollama daemon failed to load delegation target "${targetKey}": ${msg}`);
      }
      throw err;
    }
  }

  private makeHold(
    backend: BackendController,
    keys: string[],
    targetKey: string,
    bestEffort: boolean,
  ): DelegationHold {
    let released = false;
    return {
      backend,
      targetKey,
      bestEffort,
      release: () => {
        if (released) return;
        released = true;
        for (const key of keys) this.unpin(key);
        log.info(`[DelegationGate] hold released: ${targetKey}`);
      },
    };
  }

  private pin(key: string): void {
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
  }

  private unpin(key: string): void {
    const next = (this.pins.get(key) ?? 0) - 1;
    if (next <= 0) this.pins.delete(key);
    else this.pins.set(key, next);
  }

  private noFreeSlotReason(targetKey: string): string {
    return (
      `No free backend slot for delegation target "${targetKey}": all ` +
      `${this.ops.maxSlots()} slot(s) are in use (max_simultaneous_models) and ` +
      'loading it would evict a resident model. Increase max_simultaneous_models ' +
      'to allow it — note a free slot only reserves a port; it does not ' +
      'guarantee actual RAM/VRAM headroom for the model.'
    );
  }
}
