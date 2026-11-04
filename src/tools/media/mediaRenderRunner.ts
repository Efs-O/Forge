/**
 * Start one media render: lease, GPU freeing, background adapter, guaranteed
 * lease release.
 *
 * The plan's order (docs/plans/MEDIA_SHIPPED_PLAN.md §1 "Each tool" steps 2-5)
 * is load-bearing: take the shared GPU lease BEFORE any unload, free only the
 * overlapping models THROUGH Forge's lifecycle, then start the adapter as a
 * background execution so the turn returns at once. The lease is released on
 * every exit path — the ledger's CI-enforceable row — because a lease left
 * behind blocks every later render on this machine until its pid goes stale.
 */
import { acquireMediaGpuLease, type MediaGpuLeaseHandle } from '../../media/mediaGpuLease';
import { getLogger } from '../../util/logger';
import { lookupWindowsProcess } from '../../backend/sdServerOwnerRecord';
import {
  backgroundExecutionManager,
  type BackgroundExecutionManager,
  type BackgroundExecutionCompletion,
} from '../BackgroundExecutionManager';
import { freeGpusForEngine, type MediaModelLifecycle } from './mediaGpuFreeing';
import { archiveAnalysisManifest, mediaOutcomeNotice } from './mediaManifest';

export interface MediaRenderRequest {
  runId: string;
  runDir: string;
  kind: 'video' | 'music';
  engineId: string;
  cudaDevices: readonly number[];
  /** `<configured python> <extension>/resources/media/media_job.py <job file>`. */
  command: string;
  args: readonly string[];
  cwd: string;
  jobFile: string;
  /** CUDA mask + run-local caches, set before Python starts (`media_job.require_cuda_environment`). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The chat to wake when this stage ends; its notice carries `summary`. */
  conversationId?: string;
  /**
   * The stage that must finish before this one can start — an audio analysis
   * whose text becomes the next stage's caption. Called after this stage's
   * child exits, while the lease is still held, so the two stages never
   * queue behind each other's GPU.
   */
  next?: () => Promise<MediaRenderRequest | undefined>;
  /**
   * The calling turn's abort. It stops the pre-spawn waits, never a running
   * render, and it stops a NEXT stage from being spawned: the stage already
   * running keeps its lease until its child is terminal.
   */
  abortSignal?: AbortSignal;
  /** Runs once the final child is terminal, even if its exit notice was observed early. */
  onFinished?: (completion: BackgroundExecutionCompletion) => Promise<void>;
}

export interface MediaRenderDeps {
  /** Loaded models, their busy state, and Forge's unload path. */
  lifecycle: MediaModelLifecycle;
  /** The model this conversation is generating with; see `freeGpusForEngine`. */
  ownModelName?: string;
  /**
   * Injectable: the real manager spawns; a unit test hands in a fake. Only
   * these two methods are used, so the seam stays a `Pick` rather than the
   * whole class.
   */
  background?: Pick<BackgroundExecutionManager, 'start' | 'waitFinished'>;
  acquireLease?: typeof acquireMediaGpuLease;
  /** Injectable lease location and process identity, so a test needs no Windows probe. */
  leasePath?: string;
  leasePid?: number;
  leaseProcessStartTime?: number;
  lookupProcessStartTime?: (pid: number) => Promise<number | undefined>;
  /** Injectable timers for the idle wait. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  idleWaitMs?: number;
  idlePollMs?: number;
  log?: (line: string) => void;
}

export interface MediaRenderStart {
  runId: string;
  executionId: string;
  pid: number | undefined;
  jobFile: string;
  unloaded: readonly string[];
  untouched: readonly { name: string; reason: string }[];
}

const defaultLog = (line: string): void => {
  getLogger().info(line);
};

async function defaultLookupProcessStartTime(pid: number): Promise<number | undefined> {
  return (await lookupWindowsProcess(pid))?.createdAt;
}

function releaseLease(lease: MediaGpuLeaseHandle, log: (line: string) => void): Promise<void> {
  return lease.release().then(
    () => undefined,
    (error: unknown) => {
      log(
        `[media] Could not release the media GPU lease: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Its staleness rule reclaims it once this pid is gone.',
      );
    },
  );
}

/**
 * Start one stage and re-attribute the lease to its child. The lease must name
 * the adapter, not this window: a force-killed extension host leaves the child
 * running with its VRAM, and a lease naming a dead pid would let a second
 * render start on top of it. A failed transfer is logged, never fatal — the
 * render has already started and the lease still names a live pid.
 */
type BackgroundSeam = Pick<BackgroundExecutionManager, 'start' | 'waitFinished'>;

async function spawnStage(
  req: MediaRenderRequest,
  lease: MediaGpuLeaseHandle,
  deps: MediaRenderDeps,
  background: BackgroundSeam,
  log: (line: string) => void,
): Promise<MediaRenderStart> {
  // Only the stage that ends a run may wake the chat: an audio analysis stage
  // that woke it would tell the conversation "completed" before a single note
  // was rendered. `req.next` is what says another stage follows, so the wake
  // and its manifest summary ride on the final stage alone.
  const final = req.next === undefined;
  const started = background.start({
    command: req.command,
    args: [...req.args],
    cwd: req.cwd,
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    ...(req.env ? { env: req.env } : {}),
    ...(final && req.conversationId ? { notifyConversationId: req.conversationId } : {}),
    // Read at exit, so the adapter's own final `manifest.json` write has
    // landed: a finished run reports its outputs, a run that died says it
    // ended without a manifest and hands over the tail of its log (the
    // ledger's manifest row). A non-final stage has no notice to carry, and
    // the manifest it does write is moved aside before the next stage starts.
    ...(final
      ? {
          exitSummary: () =>
            mediaOutcomeNotice(req.runDir).then((outcome) => outcome.lines.join('\n')),
        }
      : {}),
  });
  if (started.pid !== undefined) {
    try {
      const startTime = await (deps.lookupProcessStartTime ?? defaultLookupProcessStartTime)(
        started.pid,
      );
      if (startTime !== undefined) await lease.transfer(started.pid, startTime);
    } catch (error) {
      log(
        `[media] The GPU lease still names this window, not the render child: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    runId: req.runId,
    executionId: started.id,
    pid: started.pid,
    jobFile: req.jobFile,
    unloaded: [],
    untouched: [],
  };
}

/**
 * Wait out every stage of this run, then release the lease exactly once.
 * `waitFinished` is used rather than `observe` because `observe` marks the exit
 * notice seen, and the notice is what tells the chat the render is done. A
 * stage that cannot be prepared (a missing analysis result, say) is logged and
 * ends the chain: the lease still goes back.
 *
 * The wait carries no abort signal on purpose. Forge's rule for a background
 * job is that stopping the turn does not stop the job - `disarmNotify` only
 * silences its notice - so handing the lease back while this run's child still
 * holds VRAM would let a second render start on top of it. The abort is
 * honoured where it can be: between stages, before the next spawn.
 */
async function runStages(
  first: MediaRenderStart,
  firstReq: MediaRenderRequest,
  lease: MediaGpuLeaseHandle,
  deps: MediaRenderDeps,
  log: (line: string) => void,
): Promise<void> {
  const background: BackgroundSeam = deps.background ?? backgroundExecutionManager;
  let current = first;
  let currentReq = firstReq;
  let stage = 1;
  try {
    for (;;) {
      try {
        const completion = await background.waitFinished(current.executionId);
        if (!currentReq.next) {
          try {
            await currentReq.onFinished?.(completion);
          } catch (error) {
            log(
              `[media] Completed output delivery failed for run ${currentReq.runId}: ` +
                `${error instanceof Error ? error.message : String(error)}. The files remain in the run folder.`,
            );
          }
          break;
        }
      } catch (error) {
        log(
          `[media] Could not wait for execution ${current.executionId}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            'The lease is released now rather than left to staleness.',
        );
        break;
      }
      if (firstReq.abortSignal?.aborted) {
        log(
          `[media] Run ${currentReq.runId} was stopped after stage ${stage}: the turn was ` +
            'cancelled, so no further stage was started. The lease is released now.',
        );
        break;
      }
      let nextReq: MediaRenderRequest | undefined;
      try {
        nextReq = await currentReq.next();
      } catch (error) {
        log(
          `[media] The next stage of run ${currentReq.runId} was not started: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
      if (!nextReq) break;
      // The stage that just ended wrote its own `manifest.json`. Rename it
      // aside as `analysis-manifest.json` (kept: it is the analysis record) so
      // the final notice can only read the render's own manifest, and a render
      // that died without one is reported as "ended without a manifest".
      if (!(await archiveAnalysisManifest(currentReq.runDir, log))) break;
      current = await spawnStage(nextReq, lease, deps, background, log);
      currentReq = nextReq;
      stage += 1;
    }
  } finally {
    await releaseLease(lease, log);
  }
}

/**
 * Start the render. Anything thrown after the lease is taken releases the lease
 * on its way out — a failed unload, an aborted turn before the spawn, or a
 * background manager that refuses the spawn — and the caller reports it to the
 * chat, per the ledger row "an unload that throws aborts the render before it
 * starts; the lease is released; the error goes to the chat".
 */
export async function startMediaRender(
  req: MediaRenderRequest,
  deps: MediaRenderDeps,
): Promise<MediaRenderStart> {
  const log = deps.log ?? defaultLog;
  const background = deps.background ?? backgroundExecutionManager;
  const acquire = deps.acquireLease ?? acquireMediaGpuLease;
  const owner = `media:${req.kind}:${req.engineId}`;
  const lease = await acquire(owner, req.cudaDevices[0], {
    ...(deps.leasePath ? { leasePath: deps.leasePath } : {}),
    ...(deps.leasePid ? { pid: deps.leasePid } : {}),
    ...(deps.leaseProcessStartTime ? { processStartTime: deps.leaseProcessStartTime } : {}),
    ...(deps.lookupProcessStartTime ? { lookupProcessStartTime: deps.lookupProcessStartTime } : {}),
  });
  try {
    const freed = await freeGpusForEngine(
      req.cudaDevices,
      {
        lifecycle: deps.lifecycle,
        ...(deps.ownModelName ? { ownModelName: deps.ownModelName } : {}),
        ...(deps.wait ? { wait: deps.wait } : {}),
        ...(deps.idleWaitMs ? { idleWaitMs: deps.idleWaitMs } : {}),
        ...(deps.idlePollMs ? { idlePollMs: deps.idlePollMs } : {}),
        log,
      },
      req.abortSignal,
    );
    const started = await spawnStage(req, lease, deps, background, log);
    started.unloaded = freed.unloaded;
    started.untouched = freed.untouched;
    void runStages(started, req, lease, deps, log).catch((error: unknown) => {
      log(
        `[media] Background lease watch failed for ${started.executionId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return started;
  } catch (error) {
    await releaseLease(lease, log);
    throw error;
  }
}
