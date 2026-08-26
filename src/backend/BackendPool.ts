import type { BackendController } from './BackendController';
import { DirectBackend } from './DirectBackend';
import type { ForgeConfig } from '../config/types';
import {
  expandAlias,
  resolveRequestModel,
  resolveSpawnModel,
  splitModelProfile,
} from '../config/ConfigResolver';
import { DelegationGate } from './DelegationGate';
import type { DelegationCheck, DelegationHold } from './DelegationGate';
import { getLogger } from '../util/logger';
import { SharedRuntimeRegistry, sharedRuntimeKey } from './SharedRuntimeRegistry';
import { acquireOllamaSlot, borrowSharedRuntime, stopAllSlots } from './poolAcquisition';
import { claimPort, freeSlot, mostRecentSlot } from './poolSlots';
import {
  changedStructuralSettings,
  readStructuralSettings,
  warnStructuralReloadRequired,
  withPinnedStructuralSettings,
} from './poolStructuralConfig';
import type { StructuralSettings } from './poolStructuralConfig';
import type { PortClaim, PoolSlot, SlotTable } from './poolSlots';
import type { IBackendPool } from './poolTypes';
import { reconcileDeadSlot, restartSlot, startSlot, type SlotStartContext } from './poolStart';

export type { DelegationCheck, DelegationHold } from './DelegationGate';
export type { IBackendPool } from './poolTypes';

const log = getLogger();

export class BackendPool implements IBackendPool {
  private readonly slots = new Map<string, PoolSlot>();
  /** Compatible servers owned by another Forge window; never consume our ports. */
  private readonly sharedSlots = new Map<
    string,
    { backend: DirectBackend; key: string; leaseId: string }
  >();
  /** Injectable so tests exercise lease bookkeeping against a temp root
   *  instead of the real per-machine registry under LOCALAPPDATA. */
  private readonly sharedRegistry: SharedRuntimeRegistry;
  // Ollama models connect to a pre-running daemon and don't consume a port slot.
  private readonly ollamaSlots = new Map<string, DirectBackend>();
  /** model → in-flight ollama acquire, so concurrent acquires share one hotSwap. */
  private readonly ollamaStarting = new Map<string, Promise<BackendController>>();
  /** Model releases in progress; every later acquire waits for teardown. */
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly freePorts: number[];
  private readonly gate: DelegationGate;
  /** Settings baked into the physical slot/port inventory at construction. */
  private readonly structural: StructuralSettings;
  private lastAcquiredModel: string | null = null;

  constructor(
    private config: ForgeConfig,
    sharedRegistry: SharedRuntimeRegistry = new SharedRuntimeRegistry(),
  ) {
    this.sharedRegistry = sharedRegistry;
    const max = config.max_simultaneous_models ?? 1;
    const base = config.llama_server.port ?? 8080;
    this.freePorts = Array.from({ length: max }, (_, i) => base + i);
    // Snapshot, never re-derived: the whole failure mode this guards against is
    // policy reading a new value while the physical slots are still the old one.
    this.structural = readStructuralSettings(config);
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

  /**
   * Hot-reload the config, PINNING the settings baked into the physical pool.
   *
   * `freePorts` is built once in the constructor. Letting a reload change
   * `max_simultaneous_models` or `llama_server.port` in `this.config` would
   * leave capacity policy (DelegationGate.maxSlots) reading a value the actual
   * slot table does not implement — a warning alone does not close that gap,
   * so the old values are carried forward and the user is told a reload is
   * required. Everything else applies immediately.
   */
  applyForgeConfig(next: ForgeConfig): void {
    const changed = changedStructuralSettings(this.structural, next);
    this.config = changed.length === 0 ? next : withPinnedStructuralSettings(this.structural, next);
    for (const slot of this.slots.values()) slot.backend.applyForgeConfig(this.config);
    for (const backend of this.ollamaSlots.values()) backend.applyForgeConfig(this.config);
    if (changed.length > 0) warnStructuralReloadRequired(changed);
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

  /**
   * Per-model readiness, as opposed to `isAnyReady`'s pool-wide answer. A model
   * that is resident but still spawning returns false — that gap is the whole
   * point, since it is the tens of seconds a cold llama-server spends reading
   * weights before it can serve.
   */
  isModelReady(modelName: string): boolean {
    return this.backendFor(this.poolKey(modelName))?.isReady() ?? false;
  }

  /**
   * Change-detection key, not a data structure to parse. Covers residency and
   * readiness together so a slot that finished starting registers as a change
   * even though the set of resident models did not move.
   */
  residencySignature(): string {
    const keys = [...this.slots.keys(), ...this.sharedSlots.keys(), ...this.ollamaSlots.keys()];
    return keys
      .sort()
      .map((key) => `${key}:${this.backendFor(key)?.isReady() ? 'r' : 's'}`)
      .join(',');
  }

  /** The backend behind an already-resolved pool key, wherever it lives. */
  private backendFor(key: string): DirectBackend | undefined {
    return (
      this.slots.get(key)?.backend ??
      this.sharedSlots.get(key)?.backend ??
      this.ollamaSlots.get(key)
    );
  }

  private claimPort(allowEvict: boolean): PortClaim {
    return claimPort(this.slotTable(), allowEvict);
  }

  private startSlot(modelName: string, claim: PortClaim): Promise<BackendController> {
    return startSlot(this.slotStartContext(), modelName, claim);
  }

  private restartSlot(modelName: string, slot: PoolSlot): Promise<BackendController> {
    return restartSlot(this.slotStartContext(), modelName, slot);
  }

  /** Rebuilt per call: `config` is replaced wholesale by a hot reload. */
  private slotStartContext(): SlotStartContext {
    return {
      config: this.config,
      slots: this.slots,
      registry: this.sharedRegistry,
      runtimeKey: (model) => this.runtimeKey(model),
      onUnexpectedExit: (model) => reconcileDeadSlot(this.slotStartContext(), model),
      freeSlot: (model, slot) => this.freeSlot(model, slot),
      onAcquired: (model) => {
        this.lastAcquiredModel = model;
      },
    };
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

  /** Identity of the llama-server this model would spawn. Uses the SPAWN model:
   *  request-time profile fields do not change the server, so they must not
   *  fork its identity and block an otherwise compatible share. */
  private runtimeKey(modelName: string): string {
    return sharedRuntimeKey(resolveSpawnModel(this.config, modelName), this.config.llama_server);
  }

  private borrowSharedRuntime(modelName: string): Promise<BackendController | undefined> {
    return borrowSharedRuntime(
      { config: this.config, registry: this.sharedRegistry, key: this.runtimeKey(modelName) },
      modelName,
      (record) => {
        // Re-borrowing replaces the slot record, so any lease the previous
        // attachment held must be released HERE — once the record is
        // overwritten its leaseId is unrecoverable, and the file it left
        // behind names a pid that is still very much alive (our own). The
        // owner would then see a live borrower forever and never be able to
        // unload: precisely the failure shared leases exist to prevent.
        //
        // Reached whenever a borrowed backend goes not-ready and is borrowed
        // again — the owner's llama-server dying and being respawned is the
        // ordinary way in.
        const previous = this.sharedSlots.get(modelName);
        if (previous) this.sharedRegistry.releaseLease(previous.key, previous.leaseId);
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
