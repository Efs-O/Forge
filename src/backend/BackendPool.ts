import type { BackendController } from './BackendController';
import { DirectBackend } from './DirectBackend';
import type { ForgeConfig } from '../config/types';
import { expandAlias, resolveRequestModel, splitModelProfile } from '../config/ConfigResolver';
import { DelegationGate } from './DelegationGate';
import type { DelegationCheck, DelegationGroupHold, DelegationHold } from './DelegationGate';
import { getLogger } from '../util/logger';
import { SharedRuntimeRegistry, sharedRuntimeKey } from './SharedRuntimeRegistry';
import { acquireOllamaSlot, borrowSharedRuntime, stopAllSlots } from './poolAcquisition';
import { claimPort, freeSlot, mostRecentSlot } from './poolSlots';
import type { PortClaim, PoolSlot, SlotTable } from './poolSlots';

export type { DelegationCheck, DelegationGroupHold, DelegationHold } from './DelegationGate';

const log = getLogger();

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
  /** Model releases in progress; every later acquire waits for teardown. */
  private readonly releasing = new Map<string, Promise<void>>();
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
    const pendingReleases = this.pendingReleaseWait();
    if (pendingReleases) await pendingReleases;

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
    return this.startSlot(key, this.claimPort(allowEvict));
  }

  async release(modelName: string): Promise<void> {
    const key = this.poolKey(modelName);
    const existingRelease = this.releasing.get(key);
    if (existingRelease) {
      await existingRelease;
      return;
    }

    const release = this.releaseKey(key);
    this.releasing.set(key, release);
    try {
      await release;
    } finally {
      if (this.releasing.get(key) === release) this.releasing.delete(key);
    }
  }

  private async releaseKey(key: string): Promise<void> {
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
      // Borrowed: detach this client only — the process belongs to another
      // window. The finally is load-bearing: the lease and the slot entry must
      // be cleaned up even if detach fails, or the owner can never unload.
      try {
        await shared.backend.detach();
      } finally {
        this.sharedRegistry.releaseLease(shared.key, shared.leaseId);
        this.sharedSlots.delete(key);
      }
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

  /**
   * A sidebar model switch can release its old backend without awaiting the
   * result before the next prompt arrives. Wait here as the final barrier
   * before any acquire so a free port never allows two GGUF servers to overlap
   * during that transition.
   */
  private pendingReleaseWait(): Promise<void> | undefined {
    const pending = [...this.releasing.values()];
    if (pending.length === 0) return undefined;
    return Promise.all(pending).then(() => {
      const next = this.pendingReleaseWait();
      return next ?? Promise.resolve();
    });
  }

  async stopAll(): Promise<void> {
    await stopAllSlots({
      slots: this.slots,
      ollamaSlots: this.ollamaSlots,
      sharedSlots: this.sharedSlots,
      registry: this.sharedRegistry,
      sharedRuntimeEnabled: this.config.shared_runtime?.enabled === true,
      runtimeKey: (model) => this.runtimeKey(model),
    });
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

  /**
   * Is ANY endpoint healthy and able to serve a request right now?
   *
   * Callers use this to gate sending work and to drive the status bar, so a
   * runtime borrowed from another Forge window counts: it is a usable endpoint
   * even though this window owns neither the process nor a port slot.
   * Distinct from `isLoaded` (residency) — do not conflate the two.
   */
  isAnyReady(): boolean {
    return (
      [...this.slots.values()].some((s) => s.backend.isReady()) ||
      [...this.sharedSlots.values()].some((s) => s.backend.isReady()) ||
      [...this.ollamaSlots.values()].some((b) => b.isReady())
    );
  }

  /** Models occupying a port-consuming slot, owned or borrowed. Ollama models
   *  are deliberately absent: they are unbounded and never evicted, so they
   *  are irrelevant to the capacity decisions this feeds. */
  loadedModelNames(): string[] {
    return [...this.slots.keys(), ...this.sharedSlots.keys()];
  }

  /**
   * Is this model resident anywhere — owned slot, borrowed runtime, or Ollama
   * daemon? Residency, NOT readiness: a resident model can still be starting
   * or unhealthy. Use `isAnyReady` to decide whether work can be dispatched.
   */
  isLoaded(modelName: string): boolean {
    const key = this.poolKey(modelName);
    return this.slots.has(key) || this.sharedSlots.has(key) || this.ollamaSlots.has(key);
  }

  private claimPort(allowEvict: boolean): PortClaim {
    return claimPort(this.slotTable(), allowEvict);
  }

  private startSlot(modelName: string, claim: PortClaim): Promise<BackendController> {
    const { port, evicted } = claim;
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
   * (docs/archive/validation/RELAY_SMOKE_FINDINGS.md F5). Skipped while a restart is in flight —
   * restartSlot owns the slot during `starting` and frees it itself on failure.
   */
  private reconcileDeadSlot(modelName: string): void {
    const slot = this.slots.get(modelName);
    if (!slot || slot.starting) return;
    log.warn(`[BackendPool] backend for "${modelName}" died — freeing slot on port ${slot.port}`);
    this.freeSlot(modelName, slot);
  }

  private freeSlot(modelName: string, slot: PoolSlot): void {
    freeSlot(this.slotTable(), modelName, slot);
  }

  private getMostRecentSlot(): PoolSlot | undefined {
    return mostRecentSlot(this.slots);
  }

  private slotTable(): SlotTable {
    return {
      slots: this.slots,
      freePorts: this.freePorts,
      isPinned: (model) => this.gate.isPinned(model),
    };
  }

  private isOllamaModel(modelName: string): boolean {
    return this.config.models.find((m) => m.name === modelName)?.provider === 'ollama';
  }

  private runtimeKey(modelName: string): string {
    return sharedRuntimeKey(resolveRequestModel(this.config, modelName));
  }

  private borrowSharedRuntime(modelName: string): Promise<BackendController | undefined> {
    return borrowSharedRuntime(
      { config: this.config, registry: this.sharedRegistry, key: this.runtimeKey(modelName) },
      modelName,
      (record) => {
        this.sharedSlots.set(modelName, record);
        this.lastAcquiredModel = modelName;
      },
    );
  }

  private acquireOllama(modelName: string): Promise<BackendController> {
    return acquireOllamaSlot(
      { config: this.config, slots: this.ollamaSlots, starting: this.ollamaStarting },
      modelName,
    );
  }
}
