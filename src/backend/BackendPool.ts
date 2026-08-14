import type { BackendController } from './BackendController';
import { DirectBackend } from './DirectBackend';
import { probeHealthy } from './HealthCheck';
import type { ForgeConfig } from '../config/types';
import { expandAlias, resolveRequestModel, splitModelProfile } from '../config/ConfigResolver';
import { DelegationGate } from './DelegationGate';
import type { DelegationCheck, DelegationGroupHold, DelegationHold } from './DelegationGate';
import { getLogger } from '../util/logger';
import { SharedRuntimeRegistry, sharedRuntimeKey } from './SharedRuntimeRegistry';

export type { DelegationCheck, DelegationGroupHold, DelegationHold } from './DelegationGate';

const log = getLogger();

interface PoolSlot {
  backend: DirectBackend;
  port: number;
  lastUsed: number;
  /** Resolves when the slot finishes starting up; null when already ready. */
  starting: Promise<void> | null;
}

export interface IBackendPool {
  acquire(modelName: string): Promise<BackendController>;
  /** Read-only capacity query: would delegating from `primaryModel` to
   *  `targetModel` be possible without evicting any loaded backend? Never
   *  mutates pool state and never triggers the LRU eviction in acquire(). */
  canDelegate(primaryModel: string, targetModel: string): DelegationCheck;
  /** Atomic non-evicting target acquire. Pins primary and target until release —
   *  closes the canDelegate→acquire TOCTOU race. Release exactly once on
   *  success, cancellation, and failure paths (extra calls are no-ops). */
  acquireForDelegation(primaryModel: string, targetModel: string): Promise<DelegationHold>;
  acquireGroupForDelegation(
    primaryModel: string,
    targetModels: readonly string[],
  ): Promise<DelegationGroupHold>;
  parallelCapacity(modelName: string): number;
  /** Stop and remove a single model's backend, freeing its VRAM / port slot. */
  release(modelName: string): Promise<void>;
  stopAll(): Promise<void>;
  applyForgeConfig(next: ForgeConfig): void;
  showConsole(modelName?: string): void;
  isAnyReady(): boolean;
  /** Names of models currently holding a port slot (llama.cpp/direct). Used by
   *  the control server to make capacity/eviction decisions. Excludes Ollama,
   *  which is daemon-backed and does not consume a slot. */
  loadedModelNames(): string[];
  /** Whether the model currently has a live backend (llama.cpp slot OR ollama). */
  isLoaded(modelName: string): boolean;
}

export class BackendPool implements IBackendPool {
  private readonly slots = new Map<string, PoolSlot>();
  /** Compatible servers owned by another Forge window; never consume our ports. */
  private readonly sharedSlots = new Map<
    string,
    { backend: DirectBackend; key: string; leaseId: string }
  >();
  private readonly sharedRegistry = new SharedRuntimeRegistry();
  // Ollama models connect to a pre-running daemon and don't consume a port slot.
  private readonly ollamaSlots = new Map<string, DirectBackend>();
  /** model → in-flight ollama acquire, so concurrent acquires share one hotSwap. */
  private readonly ollamaStarting = new Map<string, Promise<BackendController>>();
  private readonly freePorts: number[];
  private readonly gate: DelegationGate;
  private lastAcquiredModel: string | null = null;

  constructor(private config: ForgeConfig) {
    const max = config.max_simultaneous_models ?? 1;
    const base = config.llama_server.port ?? 8080;
    this.freePorts = Array.from({ length: max }, (_, i) => base + i);
    this.gate = new DelegationGate({
      poolKey: (name) => this.poolKey(name),
      isOllama: (key) => this.isOllamaModel(key),
      hasSlot: (key) => this.slots.has(key),
      freeSlotCount: () => this.freePorts.length,
      maxSlots: () => this.config.max_simultaneous_models ?? 1,
      acquireNonEvicting: (key) => this.acquireByKey(key, false),
    });
  }

  /** Pool slots are keyed by base model name: a trailing @profile (or an alias)
   *  is request-time only and must never force a separate spawn (F6). */
  private poolKey(modelName: string): string {
    return splitModelProfile(expandAlias(this.config, modelName)).base;
  }

  canDelegate(primaryModel: string, targetModel: string): DelegationCheck {
    return this.gate.check(primaryModel, targetModel);
  }

  acquireForDelegation(primaryModel: string, targetModel: string): Promise<DelegationHold> {
    return this.gate.acquire(primaryModel, targetModel);
  }

  acquireGroupForDelegation(
    primaryModel: string,
    targetModels: readonly string[],
  ): Promise<DelegationGroupHold> {
    return this.gate.acquireGroup(primaryModel, targetModels);
  }

  parallelCapacity(modelName: string): number {
    const model = resolveRequestModel(this.config, modelName);
    return model?.n_parallel ?? this.config.llama_server.n_parallel ?? 4;
  }

  acquire(modelName: string): Promise<BackendController> {
    return this.acquireByKey(this.poolKey(modelName), true);
  }

  /** `key` must already be a pool key. `allowEvict: false` never evicts —
   *  used by DelegationGate, whose synchronous capacity check must stay valid
   *  through the synchronous slot claim below. */
  private async acquireByKey(key: string, allowEvict: boolean): Promise<BackendController> {
    if (this.isOllamaModel(key)) {
      this.lastAcquiredModel = key;
      return this.acquireOllama(key);
    }

    const existing = this.slots.get(key);

    if (existing) {
      // Already starting up — wait for it
      if (existing.starting) await existing.starting;
      if (existing.backend.isReady()) {
        existing.lastUsed = Date.now();
        this.lastAcquiredModel = key;
        return existing.backend;
      }
      // Was ready but crashed — restart in the same slot
      return this.restartSlot(key, existing);
    }

    const borrowed = this.sharedSlots.get(key);
    if (borrowed?.backend.isReady()) return borrowed.backend;
    if (this.config.shared_runtime?.enabled) {
      const borrowedBackend = await this.borrowSharedRuntime(key);
      if (borrowedBackend) return borrowedBackend;
    }

    // Need a new slot
    const port = this.allocatePort(allowEvict);
    return this.startSlot(key, port);
  }

  async release(modelName: string): Promise<void> {
    const key = this.poolKey(modelName);
    if (this.gate.isPinned(key)) {
      throw new Error(`Cannot release "${key}": an active delegation hold is using it.`);
    }
    if (this.isOllamaModel(key)) {
      const backend = this.ollamaSlots.get(key);
      if (backend) {
        await backend.stop().catch(() => {});
        this.ollamaSlots.delete(key);
      }
    } else if (this.sharedSlots.has(key)) {
      const shared = this.sharedSlots.get(key)!;
      await shared.backend.stop();
      this.sharedRegistry.releaseLease(shared.key, shared.leaseId);
      this.sharedSlots.delete(key);
    } else {
      const slot = this.slots.get(key);
      if (slot) {
        const runtimeKey = this.runtimeKey(key);
        if (this.config.shared_runtime?.enabled && this.sharedRegistry.hasBorrowers(runtimeKey)) {
          throw new Error(
            `Cannot unload "${key}": another Forge workspace is using this shared runtime.`,
          );
        }
        if (slot.starting) await slot.starting.catch(() => {});
        await slot.backend.stop().catch(() => {});
        this.freeSlot(key, slot);
        if (this.config.shared_runtime?.enabled) this.sharedRegistry.removeOwner(runtimeKey);
      }
    }
    log.info(`[BackendPool] released: ${key}`);
  }

  async stopAll(): Promise<void> {
    for (const [model, shared] of this.sharedSlots) {
      await shared.backend.stop().catch(() => {});
      this.sharedRegistry.releaseLease(shared.key, shared.leaseId);
      this.sharedSlots.delete(model);
    }
    const slotStops = [...this.slots.entries()].map(async ([model, slot]) => {
      if (
        this.config.shared_runtime?.enabled &&
        this.sharedRegistry.hasBorrowers(this.runtimeKey(model))
      ) {
        log.info(`[BackendPool] retained shared runtime: ${model}`);
        return;
      }
      try {
        if (slot.starting) await slot.starting.catch(() => {});
        await slot.backend.stop();
      } catch {
        // best-effort
      }
    });
    const ollamaStops = [...this.ollamaSlots.values()].map(async (backend) => {
      try {
        await backend.stop();
      } catch {
        /* best-effort */
      }
    });
    await Promise.all([...slotStops, ...ollamaStops]);
    for (const model of [...this.slots.keys()]) {
      if (
        !this.config.shared_runtime?.enabled ||
        !this.sharedRegistry.hasBorrowers(this.runtimeKey(model))
      ) {
        this.sharedRegistry.removeOwner(this.runtimeKey(model));
        this.slots.delete(model);
      }
    }
    this.ollamaSlots.clear();
    log.info('[BackendPool] all slots stopped');
  }

  applyForgeConfig(next: ForgeConfig): void {
    this.config = next;
    for (const slot of this.slots.values()) slot.backend.applyForgeConfig(next);
    for (const backend of this.ollamaSlots.values()) backend.applyForgeConfig(next);
  }

  showConsole(modelName?: string): void {
    const target = modelName ?? this.lastAcquiredModel;
    if (target) {
      this.slots.get(target)?.backend.showConsole();
    } else {
      // Show the most recently used slot
      const lru = this.getMostRecentSlot();
      lru?.backend.showConsole();
    }
  }

  isAnyReady(): boolean {
    return (
      [...this.slots.values()].some((s) => s.backend.isReady()) ||
      [...this.ollamaSlots.values()].some((b) => b.isReady())
    );
  }

  loadedModelNames(): string[] {
    // Port-consuming slots only; Ollama models are unbounded and never evicted.
    return [...this.slots.keys(), ...this.sharedSlots.keys()];
  }

  isLoaded(modelName: string): boolean {
    const key = this.poolKey(modelName);
    return this.slots.has(key) || this.sharedSlots.has(key) || this.ollamaSlots.has(key);
  }

  private allocatePort(allowEvict: boolean): number {
    if (this.freePorts.length > 0) {
      return this.freePorts.shift()!;
    }
    if (!allowEvict) {
      // Unreachable via DelegationGate (it pre-checks synchronously); kept as
      // a hard guard so a non-evicting acquire can never evict.
      throw new Error('BackendPool: no free slot for a non-evicting acquire');
    }
    // Evict LRU slot — models pinned by delegation holds are not candidates.
    const lruEntry = this.getLruEntry();
    if (!lruEntry)
      throw new Error(
        'BackendPool: no free slot and no eviction candidate — all resident models ' +
          'are pinned by active delegation holds. Retry after delegation completes.',
      );
    const [lruModel, lruSlot] = lruEntry;
    log.info(`[BackendPool] evicting LRU slot: ${lruModel} on port ${lruSlot.port}`);
    void lruSlot.backend.stop().catch(() => {});
    this.slots.delete(lruModel);
    return lruSlot.port;
  }

  private startSlot(modelName: string, port: number): Promise<BackendController> {
    const backend = new DirectBackend(this.config, port);
    let resolveStart!: () => void;
    backend.onUnexpectedExit(() => this.reconcileDeadSlot(modelName));
    let rejectStart!: (err: unknown) => void;
    const starting = new Promise<void>((res, rej) => {
      resolveStart = res;
      rejectStart = rej;
    });
    const slot: PoolSlot = { backend, port, lastUsed: Date.now(), starting };
    this.slots.set(modelName, slot);

    const boot = backend
      .hotSwap(modelName)
      .then(() => {
        slot.starting = null;
        slot.lastUsed = Date.now();
        this.lastAcquiredModel = modelName;
        if (this.config.shared_runtime?.enabled) {
          this.sharedRegistry.publish({
            key: this.runtimeKey(modelName),
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
        this.freeSlot(modelName, slot);
        rejectStart(err);
      });

    void boot;
    return starting.then(() => backend);
  }

  private async restartSlot(modelName: string, slot: PoolSlot): Promise<BackendController> {
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
      this.lastAcquiredModel = modelName;
      resolveStart();
      return slot.backend;
    } catch (err) {
      this.freeSlot(modelName, slot);
      rejectStart(err);
      throw err;
    }
  }

  /**
   * A ready backend's process died without Forge stopping it (external kill,
   * crash). Free the slot so /models and capacity decisions reflect reality
   * (RELAY_SMOKE_FINDINGS.md F5). Skipped while a restart is in flight —
   * restartSlot owns the slot during `starting` and frees it itself on failure.
   */
  private reconcileDeadSlot(modelName: string): void {
    const slot = this.slots.get(modelName);
    if (!slot || slot.starting) return;
    log.warn(`[BackendPool] backend for "${modelName}" died — freeing slot on port ${slot.port}`);
    this.freeSlot(modelName, slot);
  }

  /**
   * Remove a slot and return its port to the free list — only if `slot` still
   * owns the map entry. A failed boot, an LRU eviction, or a concurrent
   * release may have freed it already while a caller was awaiting; pushing the
   * port twice would let two future models spawn on the same port.
   */
  private freeSlot(modelName: string, slot: PoolSlot): void {
    if (this.slots.get(modelName) !== slot) return;
    this.slots.delete(modelName);
    this.freePorts.push(slot.port);
  }

  private getLruEntry(): [string, PoolSlot] | undefined {
    let lru: [string, PoolSlot] | undefined;
    for (const entry of this.slots.entries()) {
      if (this.gate.isPinned(entry[0])) continue;
      if (!lru || entry[1].lastUsed < lru[1].lastUsed) lru = entry;
    }
    return lru;
  }

  private getMostRecentSlot(): PoolSlot | undefined {
    let recent: PoolSlot | undefined;
    for (const slot of this.slots.values()) {
      if (!recent || slot.lastUsed > recent.lastUsed) recent = slot;
    }
    return recent;
  }

  private isOllamaModel(modelName: string): boolean {
    const model = this.config.models.find((m) => m.name === modelName);
    return model?.provider === 'ollama';
  }

  private runtimeKey(modelName: string): string {
    return sharedRuntimeKey(resolveRequestModel(this.config, modelName));
  }

  private async borrowSharedRuntime(modelName: string): Promise<BackendController | undefined> {
    const key = this.runtimeKey(modelName);
    const record = this.sharedRegistry.find(key);
    if (!record || !(await probeHealthy(record.endpoint))) return undefined;
    const port = Number(new URL(record.endpoint).port);
    if (!Number.isInteger(port) || port < 1) return undefined;
    const backend = new DirectBackend(this.config, port);
    await backend.hotSwap(modelName);
    const leaseId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.sharedRegistry.acquireLease(key, leaseId);
    this.sharedSlots.set(modelName, { backend, key, leaseId });
    this.lastAcquiredModel = modelName;
    log.info(`[BackendPool] borrowed shared runtime: ${modelName} at ${record.endpoint}`);
    return backend;
  }

  private acquireOllama(modelName: string): Promise<BackendController> {
    const inFlight = this.ollamaStarting.get(modelName);
    if (inFlight) return inFlight;

    const existing = this.ollamaSlots.get(modelName);

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
      const backend = new DirectBackend(this.config, 0);
      this.ollamaSlots.set(modelName, backend);
      await backend.hotSwap(modelName);
      log.info(`[BackendPool] ollama slot ready: ${modelName}`);
      return backend;
    })();
    this.ollamaStarting.set(modelName, start);
    return start.finally(() => this.ollamaStarting.delete(modelName));
  }
}
