/**
 * The remote (laptop) leases a desktop Forge window is holding on its pool.
 *
 * Memory only: when the extension host dies, the leases, their pins and the
 * listener that created them all die with it. A lease owns exactly one pool pin
 * (`BackendPool.pinModel`) and, for a llama.cpp model, the control-server hold
 * the load took — that is what keeps `makeRoom`, `freeVramForExternal` and
 * `stopOnExit` from touching the model, exactly as a desktop turn does.
 *
 * Exactly-once release is the invariant this file exists to enforce: a pin
 * dropped twice frees a model someone is still using, and one never dropped
 * leaves the model looking busy for the rest of the window's life. Every path
 * here goes through `release()`, which is guarded per lease.
 */

import type { RemoteLeaseReleaser } from './poolTypes';
import { getLogger } from '../util/logger';

const log = getLogger();

/** How often the expiry sweep runs: a lease lapses within this of its TTL. */
export const LEASE_SWEEP_INTERVAL_MS = 30_000;

export type RemoteModelKind = 'llama.cpp' | 'managed-external';

export interface RemoteLease {
  /** Opaque id, returned to the client so a report names the lease it holds. */
  id: string;
  /** The label the client sent (its hostname). Log-only: it is not an identity,
   *  and nothing here is keyed on it for security. */
  client: string;
  /** Base config model name — the same string BackendPool keys its pins on. */
  model: string;
  port: number;
  kind: RemoteModelKind;
  /** Epoch ms. A renewal pushes it out; passing it is how an abandoned laptop
   *  stops protecting a desktop model. */
  expiresAt: number;
  /** Unpin plus the control hold, if this lease owns one. Idempotent. */
  release(): void;
}

interface LeaseEntry {
  lease: RemoteLease;
  released: boolean;
}

/** What `grant` takes: a model already loaded and pinned, with the teardown
 *  that matches the pin (and hold) the caller just took. */
export interface LeaseGrant {
  client: string;
  model: string;
  port: number;
  kind: RemoteModelKind;
  release(): void;
}

export class ModelStarterLeases implements RemoteLeaseReleaser {
  private readonly entries = new Map<string, LeaseEntry>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private nextId = 1;

  constructor(
    /** Read live, so a config reload changing `lease_ttl_s` applies to the next
     *  ensure without recreating the leases already held. */
    private readonly getTtlMs: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  /** A live lease this client holds on this model, if any. */
  find(client: string, model: string): RemoteLease | undefined {
    for (const entry of this.entries.values()) {
      if (entry.lease.client === client && entry.lease.model === model) return entry.lease;
    }
    return undefined;
  }

  /**
   * Store a new lease, releasing this client's lease on any OTHER model first:
   * each client holds at most one, so an ensure for a different model means the
   * laptop switched and no longer needs the old one.
   */
  grant(grant: LeaseGrant): RemoteLease {
    this.releaseClientExcept(grant.client, grant.model);
    const entry: LeaseEntry = {
      released: false,
      lease: {
        id: `lease-${this.nextId++}-${grant.model}`,
        client: grant.client,
        model: grant.model,
        port: grant.port,
        kind: grant.kind,
        expiresAt: this.now() + this.getTtlMs(),
        release: () => {
          if (entry.released) return;
          entry.released = true;
          if (this.entries.get(entry.lease.id) === entry) this.entries.delete(entry.lease.id);
          grant.release();
        },
      },
    };
    this.entries.set(entry.lease.id, entry);
    return entry.lease;
  }

  /** Push a lease's expiry out by a full TTL: the client is still working. */
  renew(lease: RemoteLease): RemoteLease {
    const entry = this.entries.get(lease.id);
    if (entry) entry.lease.expiresAt = this.now() + this.getTtlMs();
    return lease;
  }

  /** Drop one lease. Returns false when it was already gone (another path, or a
   *  desktop unload, got here first — both are normal). */
  release(lease: RemoteLease): boolean {
    const entry = this.entries.get(lease.id);
    if (!entry || entry.released) return false;
    entry.lease.release();
    return true;
  }

  /** Drop every lease on this pool key — a desktop `/unloadModel`, or the pool
   *  releasing the model by any other path. */
  releaseLeasesFor(modelKey: string): void {
    this.releaseWhere((entry) => entry.lease.model === modelKey);
  }

  /** Every lease this window holds — `/unloadall`, `stopAll`, config disable,
   *  listener dispose. Returns how many. */
  releaseAllLeases(): number {
    return this.releaseWhere(() => true).length;
  }

  /** One client's `POST /release`: everything it holds, whatever model. Returns
   *  the models freed, which is what the client wants to hear. */
  releaseClient(client: string): string[] {
    return this.releaseWhere((entry) => entry.lease.client === client).map((l) => l.model);
  }

  /** A client switching models: its leases on every model except the target.
   *  Run BEFORE the ensure, so `freeVramForExternal` does not see the laptop's
   *  own idle model as busy and refuse the switch. */
  releaseClientExcept(client: string, model: string): string[] {
    return this.releaseWhere(
      (entry) => entry.lease.client === client && entry.lease.model !== model,
    ).map((l) => l.model);
  }

  /** Does any live lease protect this model? Feeds `stopOnExit`'s busy check, so
   *  closing the last desktop window leaves a laptop's model running. */
  hasLease(modelName: string): boolean {
    for (const entry of this.entries.values()) {
      if (!entry.released && entry.lease.model === modelName) return true;
    }
    return false;
  }

  /** Who is leasing this model, for `GET /models`' `leasedBy`. */
  clientsFor(modelName: string): string[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.released && entry.lease.model === modelName)
      .map((entry) => entry.lease.client);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Start the expiry sweep. Called when the listener binds, so a window that
   *  never owns the port keeps no timers and no leases. */
  startWatching(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.expireNow(), LEASE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stopWatching(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /** Run the sweep immediately (dispose, and the test seam for fake timers). */
  expireNow(): void {
    const cutoff = this.now();
    for (const entry of [...this.entries.values()]) {
      if (!entry.released && entry.lease.expiresAt <= cutoff) entry.lease.release();
    }
  }

  dispose(): void {
    this.stopWatching();
    this.releaseAllLeases();
  }

  private releaseWhere(keep: (entry: LeaseEntry) => boolean): RemoteLease[] {
    const released: RemoteLease[] = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.released || !keep(entry)) continue;
      released.push(entry.lease);
      entry.lease.release();
    }
    if (released.length) log.info(`[ModelStarter] released ${released.length} remote lease(s)`);
    return released;
  }
}
