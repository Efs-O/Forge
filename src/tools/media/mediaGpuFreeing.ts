/**
 * Freeing the GPUs a media engine needs, through Forge's own model lifecycle.
 *
 * The plan's rule (docs/plans/MEDIA_SHIPPED_PLAN.md §1 step 3): never hit a
 * model's port from a script. The tool selects the loaded entries whose
 * configured GPUs overlap the engine's `cuda_devices`, waits until each is idle,
 * and then calls the same `unloadModel` the control server's `POST /unload`
 * calls — which is the path that already knows an entry's `unload_path` (Strata)
 * from a direct-spawn stop. Overlap is `poolAcquisition.gpusOverlap`, the one
 * rule every load and turn hold already uses, so an entry that never named its
 * cards is treated as wanting ALL of them: a missing answer unloads, it never
 * lets two owners share a card.
 */
import { gpusOverlap } from '../../backend/poolAcquisition';
import { getLogger } from '../../util/logger';

/** How long a busy model may be waited out before the render is refused. */
const IDLE_WAIT_MS = 120_000;
const IDLE_POLL_MS = 500;

export interface MediaLoadedModel {
  name: string;
  /** The engine's `gpus` (`ExternalModelServers.gpusOf`); absent = never said. */
  gpus?: readonly number[];
}

export interface MediaModelLifecycle {
  /** Every model this window sees as loaded, with the cards its entry configured. */
  loadedModels(): readonly MediaLoadedModel[];
  /** A sidebar turn, a delegation hold or a remote lease is using this model. */
  isBusy(modelName: string): boolean;
  /** Forge's eager teardown: `ControlModelLifecycle.unloadModel`. */
  unloadModel(modelName: string): Promise<{ unloaded: boolean; error?: string }>;
}

export interface MediaGpuFreeingDeps {
  lifecycle: MediaModelLifecycle;
  /**
   * The model this conversation is generating with. Its turn pin is held by the
   * turn that is calling the tool, so waiting on it would wait forever: the plan
   * says the calling turn does not count as busy, and the model is still
   * unloaded — the next round re-acquires it through the pool.
   */
  ownModelName?: string;
  idleWaitMs?: number;
  idlePollMs?: number;
  /** Injectable: the real wait is a timer, so a unit test never sleeps. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}

export interface MediaGpuFreeingResult {
  unloaded: readonly string[];
  untouched: readonly { name: string; reason: string }[];
}

function abortSignalError(signal?: AbortSignal): Error {
  const error = new Error('media GPU free aborted');
  error.name = 'AbortError';
  if (signal?.reason instanceof Error) error.cause = signal.reason;
  return error;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortSignalError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortSignalError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait out a busy model rather than cut it off: releasing a backend a chat is
 * streaming on would stop that chat's work in flight, which is the same thrash
 * `freeVramForExternal` refuses with `ExternalBusyError`.
 */
async function waitUntilIdle(
  model: string,
  deps: MediaGpuFreeingDeps,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!deps.lifecycle.isBusy(model)) return true;
  if (deps.ownModelName === model) return true;
  const wait = deps.wait ?? sleep;
  const pollMs = deps.idlePollMs ?? IDLE_POLL_MS;
  const deadline = Date.now() + (deps.idleWaitMs ?? IDLE_WAIT_MS);
  for (;;) {
    try {
      await wait(pollMs, signal);
    } catch (error) {
      // An aborted turn is reported as the abort the caller asked for, so the
      // runner's release path never sees a foreign timer error.
      if (signal?.aborted) throw abortSignalError(signal);
      throw error;
    }
    if (signal?.aborted) throw abortSignalError(signal);
    if (!deps.lifecycle.isBusy(model)) return true;
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Select and free the overlapping entries. Order matters for the message: the
 * models already unloaded when a later one refuses are named, because the
 * render did not start but those backends are already gone and the next turn
 * has to reload them.
 */
export async function freeGpusForEngine(
  cudaDevices: readonly number[],
  deps: MediaGpuFreeingDeps,
  signal?: AbortSignal,
): Promise<MediaGpuFreeingResult> {
  const log = deps.log ?? ((line: string) => getLogger().info(line));
  const unloaded: string[] = [];
  const untouched: { name: string; reason: string }[] = [];
  for (const model of deps.lifecycle.loadedModels()) {
    if (!gpusOverlap(model.gpus, cudaDevices)) {
      untouched.push({ name: model.name, reason: 'its GPUs do not overlap this engine' });
      continue;
    }
    if (!(await waitUntilIdle(model.name, deps, signal))) {
      throw new Error(
        `Cannot free GPU ${cudaDevices.join(', ')}: "${model.name}" is still generating after ` +
          `${(deps.idleWaitMs ?? IDLE_WAIT_MS) / 1_000}s of waiting, so the render did not start. ` +
          (unloaded.length
            ? `Already unloaded: ${unloaded.join(', ')} — the next turn loads them again.`
            : 'No model was unloaded.') +
          ' Wait for that chat, or stop it, then call the tool again.',
      );
    }
    const result = await deps.lifecycle.unloadModel(model.name);
    if (result.error) {
      throw new Error(
        `Could not unload "${model.name}" for GPU ${cudaDevices.join(', ')}: ${result.error}. ` +
          (unloaded.length
            ? `Already unloaded: ${unloaded.join(', ')}.`
            : 'No model was unloaded.') +
          ' The render did not start.',
      );
    }
    unloaded.push(model.name);
    log(
      `[media] unloaded "${model.name}" for the media GPU lease` +
        (model.gpus === undefined
          ? ' (the entry names no gpus, so it is treated as wanting every card)'
          : ''),
    );
  }
  return { unloaded, untouched };
}
