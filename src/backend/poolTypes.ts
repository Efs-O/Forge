/**
 * The contract consumers depend on. Kept apart from `BackendPool`'s
 * implementation so the sidebar, control server and tests can import the
 * interface without pulling in the pool's internals.
 */

import type { BackendController } from './BackendController';
import type { ForgeConfig } from '../config/types';
import type { DelegationCheck, DelegationHold } from './DelegationGate';
import type { BackendProcess } from '../system/SystemReport';

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
  parallelCapacity(modelName: string): number;
  /** Stop and remove a single model's backend, freeing its VRAM / port slot. */
  release(modelName: string): Promise<void>;
  stopAll(): Promise<void>;
  applyForgeConfig(next: ForgeConfig): void;
  showConsole(modelName?: string): void;
  /** Is ANY endpoint healthy and able to serve a request — owned, borrowed from
   *  another Forge window, or Ollama? Readiness, not residency. */
  isAnyReady(): boolean;
  /** Names of models currently holding a port slot (llama.cpp/direct). Used by
   *  the control server to make capacity/eviction decisions. Excludes Ollama,
   *  which is daemon-backed and does not consume a slot. */
  loadedModelNames(): string[];
  /** Whether the model currently has a live backend (llama.cpp slot OR ollama).
   *  Residency, not readiness — see `isAnyReady`. */
  isLoaded(modelName: string): boolean;
  /** Per-model readiness: is THIS model's backend serving right now? Narrower
   *  than `isAnyReady`, which answers the question for the pool as a whole. A
   *  resident model returns false while it is still spawning. */
  isModelReady(modelName: string): boolean;
  /** Model → OS pid for every llama-server THIS window spawned. Ollama models
   *  and runtimes borrowed from another Forge window contribute nothing: those
   *  processes are not ours to name. Consumed by the machine report, which
   *  cannot otherwise tell a Forge backend apart from any other VRAM holder. */
  backendProcesses(): readonly BackendProcess[];
  /** Cheap change-detection key over every slot's residency AND readiness.
   *  Pure reads. Equal signatures mean nothing observable moved, so the sidebar
   *  can skip a repost; see docs/plans/MODEL_READINESS_DOT_PLAN.md for why this is polled
   *  rather than emitted. */
  residencySignature(): string;
}
