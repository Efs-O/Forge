import type { BackendController } from './BackendController';
import { DirectBackend } from './DirectBackend';
import { probeHealthy } from './HealthCheck';
import type { ForgeConfig } from '../config/types';
import { expandAlias, splitModelProfile } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';

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
  // Ollama models connect to a pre-running daemon and don't consume a port slot.
  private readonly ollamaSlots = new Map<string, DirectBackend>();
  /** model → in-flight ollama acquire, so concurrent acquires share one hotSwap. */
  private readonly ollamaStarting = new Map<string, Promise<BackendController>>();
  private readonly freePorts: number[];
  private lastAcquiredModel: string | null = null;

  constructor(private config: ForgeConfig) {
    const max = config.max_simultaneous_models ?? 1;
    const base = config.llama_server.port ?? 8080;
    this.freePorts = Array.from({ length: max }, (_, i) => base + i);
  }

  /** Pool slots are keyed by base model name: a trailing @profile (or an alias)
   *  is request-time only and must never force a separate spawn (F6). */
  private poolKey(modelName: string): string {
    return splitModelProfile(expandAlias(this.config, modelName)).base;
  }

  async acquire(modelName: string): Promise<BackendController> {
    const key = this.poolKey(modelName);
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

    // Need a new slot
    const port = this.allocatePort();
    return this.startSlot(key, port);
  }

  async release(modelName: string): Promise<void> {
    const key = this.poolKey(modelName);
    if (this.isOllamaModel(key)) {
      const backend = this.ollamaSlots.get(key);
      if (backend) {
        await backend.stop().catch(() => {});
        this.ollamaSlots.delete(key);
      }
    } else {
      const slot = this.slots.get(key);
      if (slot) {
        if (slot.starting) await slot.starting.catch(() => {});
        await slot.backend.stop().catch(() => {});
        this.freeSlot(key, slot);
      }
    }
    log.info(`[BackendPool] released: ${key}`);
  }

  async stopAll(): Promise<void> {
    const slotStops = [...this.slots.values()].map(async (slot) => {
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
    this.slots.clear();
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
    return [...this.slots.keys()];
  }

  isLoaded(modelName: string): boolean {
    const key = this.poolKey(modelName);
    return this.slots.has(key) || this.ollamaSlots.has(key);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private allocatePort(): number {
    if (this.freePorts.length > 0) {
      return this.freePorts.shift()!;
    }
    // Evict LRU slot
    const lruEntry = this.getLruEntry();
    if (!lruEntry) throw new Error('BackendPool: no slots available and no eviction candidate');
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
