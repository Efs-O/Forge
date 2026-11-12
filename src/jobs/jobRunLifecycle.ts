/**
 * The per-job run-lifecycle leaf functions of the scheduler, extracted from
 * `JobScheduler` (pure move — no behaviour change). These are the three
 * concerns `runJob` delegates to that are distinct from the tick/lease core:
 * running a check, applying backoff after a failure, and the D6 sleep-if-idle
 * re-suspend. Each takes only the injected deps it needs (the scheduler's
 * fields are private, so the class passes them at the call site).
 */

import type { JobFile, RunRow } from './jobSchema';
import type { JobStore } from './JobStore';
import type { JobDelivery } from './JobDelivery';
import { nextDue } from './schedule';
import { runCheck, buildCheckContext } from './checks/runCheck';
import { nextDueWithBackoff, BACKOFF_THRESHOLD } from './backoff';
import {
  shouldSleepIfIdle,
  PowerControlUnsupportedError,
  type PowerControl,
  type SleepIfIdleInput,
} from '../system/PowerControl';
import type { LlamacppAction } from './actions/llamacppAction';
import type { PendingModelAction } from './jobModelLane';
import type { JobsFetchCacheEntry } from './jobsFetch';

export interface ScheduledJobRunDeps {
  store: JobStore;
  power: PowerControl;
  delivery: JobDelivery;
  now: () => Date;
  runCheck: (jobFile: JobFile) => Promise<CheckOutcome>;
  applyBackoff: (jobFile: JobFile, message: string) => Promise<void>;
  hasModelRunner: (jobFile: JobFile) => boolean;
  queueModelAction: (candidate: PendingModelAction) => void;
}

/** The result of running a job's check. */
export interface CheckOutcome {
  observation: string | null;
  changed: boolean;
  summary: string;
}

/** Run the check. Returns the observation, whether it changed, and a summary. */
export async function runJobCheck(
  getConfig: () => { allowedHosts: readonly string[]; maxConcurrent: number },
  etagCache: Map<string, JobsFetchCacheEntry>,
  llamacpp: LlamacppAction | undefined,
  jobFile: JobFile,
): Promise<CheckOutcome> {
  const { job } = jobFile;
  const { allowedHosts } = getConfig();
  const ctx = buildCheckContext(allowedHosts, job.id, etagCache);
  let checkResult = await runCheck(jobFile, ctx);

  // A mutating action (llamacpp_update) runs when the check reports a change
  // (B5). It is the only action that mutates the machine; a failure here is a
  // failed run and backs off like any other. It needs a github_release check
  // (the tag comes from the observation) and the action to be wired.
  if (checkResult.changed && job.action?.kind === 'llamacpp_update') {
    if (job.check.kind === 'github_release' && llamacpp) {
      // The type is nullable; never `JSON.parse(null)` before a machine mutation.
      const tag =
        checkResult.observation === null
          ? undefined
          : (JSON.parse(checkResult.observation) as { tag?: string }).tag;
      if (typeof tag === 'string' && tag.length > 0) {
        const stage = await llamacpp.stage(job.action, job.id, job.check.repo, tag);
        checkResult = { ...checkResult, summary: stage.summary };
      }
    }
  }

  return checkResult;
}

/** Run one bounded check and hand any model work to the scheduler's lane. */
export async function executeScheduledJob(
  jobFile: JobFile,
  isResume: boolean,
  runNow: boolean,
  deps: ScheduledJobRunDeps,
): Promise<void> {
  const { job, state } = jobFile;
  const now = deps.now();
  const wasLate = isResume && state.next_due_at !== null && state.next_due_at < now.getTime();
  let hold: ReturnType<PowerControl['holdAwake']> | undefined;
  try {
    let holdError: string | undefined;
    if (job.wake) {
      try {
        hold = deps.power.holdAwake(`job ${job.id}`);
      } catch (err) {
        if (!(err instanceof PowerControlUnsupportedError)) throw err;
        holdError = `wake hold unsupported: ${err.message}; this run continued without a hold`;
      }
    }
    const pendingTask =
      state.task_pending && (job.action?.kind === 'agent_task' || job.action?.kind === 'retitle');
    const result = pendingTask
      ? {
          observation: state.task_pending_observation ?? state.last_observation,
          changed: true,
          summary: 'retrying pending task',
        }
      : await deps.runCheck(jobFile);
    const modelAction =
      job.action?.kind === 'agent_task'
        ? 'agent_task'
        : job.action?.kind === 'retitle'
          ? 'retitle'
          : undefined;
    if (result.changed && modelAction) {
      const fresh = await deps.store.load(job.id);
      if (!fresh || (!fresh.job.enabled && !runNow)) return;
      if (deps.hasModelRunner(fresh)) {
        const pendingSince = state.task_pending_since ?? now.getTime();
        const pendingState: JobFile = {
          ...fresh,
          state: {
            ...fresh.state,
            last_observation: result.observation,
            task_pending: true,
            task_pending_reason: fresh.state.task_pending_reason ?? 'waiting for model admission',
            task_pending_since: pendingSince,
            task_pending_observation: result.observation,
          },
        };
        deps.store.patchState(job.id, {
          task_pending: true,
          task_pending_reason: pendingState.state.task_pending_reason,
          task_pending_since: pendingSince,
          task_pending_observation: result.observation,
        });
        deps.queueModelAction({
          jobFile: pendingState,
          wasLate,
          runNow,
          orderAt:
            state.task_pending && state.task_pending_since !== null
              ? state.task_pending_since
              : (state.next_due_at ?? now.getTime()),
        });
        return;
      }
      const error =
        modelAction === 'agent_task'
          ? 'agent_task runner not wired (no host facade or backend pool)'
          : 'retitle runner not wired (no storage folder for this workspace)';
      await recordUnwiredActionRun(deps.store, deps.delivery, deps.now, jobFile, wasLate, error);
      return;
    }
    if (!(await deps.store.load(job.id))) return;
    const change = await deps.delivery.deliverForChange(job, result);
    let delivered = change.delivered;
    if (
      state.consecutive_failures >= BACKOFF_THRESHOLD &&
      job.action?.kind !== 'agent_task' &&
      job.action?.kind !== 'retitle'
    ) {
      await deps.delivery.deliver(
        job,
        `recovered after ${state.consecutive_failures} consecutive failures`,
      );
      delivered++;
    }
    const nextSummaryPending = result.changed ? change.summaryPending : state.summary_pending;
    const row: RunRow = {
      at: now.getTime(),
      late: wasLate,
      outcome: 'ok',
      changed: result.changed,
      summary: holdError ? `${result.summary}; ${holdError}` : result.summary,
      delivered,
      ...(holdError ? { error: holdError } : {}),
    };
    await deps.store.appendRun(job.id, row);
    deps.store.patchState(job.id, {
      last_run_at: now.getTime(),
      last_ok_at: now.getTime(),
      last_observation: result.observation,
      consecutive_failures: 0,
      next_due_at: nextDue(job.schedule, now).getTime(),
      summary_pending: nextSummaryPending,
    });
  } catch (err) {
    const message = (err as Error).message;
    await deps.store
      .appendRun(job.id, {
        at: now.getTime(),
        late: wasLate,
        outcome: 'failed',
        changed: false,
        summary: 'run failed',
        error: message,
        delivered: 0,
      })
      .catch(() => undefined);
    await deps.applyBackoff(jobFile, message).catch(() => undefined);
  } finally {
    hold?.dispose();
  }
}

/**
 * An action whose runner is absent in this window (no host facade, no storage
 * folder, or a build too old to know the action): one failed run row naming
 * what is missing, then the shared backoff. Written once because `agent_task`
 * and `retitle` need exactly the same thing, and two copies would drift.
 */
export async function recordUnwiredActionRun(
  store: JobStore,
  delivery: JobDelivery,
  now: () => Date,
  jobFile: JobFile,
  wasLate: boolean,
  error: string,
): Promise<void> {
  await store.appendRun(jobFile.job.id, {
    at: now().getTime(),
    late: wasLate,
    outcome: 'failed',
    changed: true,
    summary: error,
    error,
    delivered: 0,
  });
  await applyJobBackoff(store, delivery, now, jobFile, error);
}

/** Apply backoff after a failure: double the interval up to 24 h (B.3). */
export async function applyJobBackoff(
  store: JobStore,
  delivery: JobDelivery,
  now: () => Date,
  jobFile: JobFile,
  message: string,
): Promise<void> {
  const { job, state } = jobFile;
  const count = state.consecutive_failures + 1;
  const at = now();
  const nextDueAt = nextDueWithBackoff(job.schedule, at, count);
  store.patchState(job.id, {
    last_run_at: at.getTime(),
    next_due_at: nextDueAt,
    consecutive_failures: count,
  });
  // Not yet backed off: that was just a normal reschedule.
  if (count < BACKOFF_THRESHOLD) return;
  // Report once, on the run that crosses the threshold. Later
  // failures keep extending the backoff silently; the recovery (a success
  // after backoff) is reported by the next successful run.
  const delivered =
    count === BACKOFF_THRESHOLD ? await delivery.tryDeliver(job, `failing: ${message}`) : 0;
  await store.appendRun(job.id, {
    at: at.getTime(),
    late: false,
    outcome: 'skipped',
    changed: false,
    summary: `backed off after ${count} failures: ${message}`,
    delivered,
  });
}

/** D6: suspend again after a wake if a job asked to and nothing is busy. */
export async function sleepIfIdleIfRequested(
  busy: () => string | undefined,
  runningJobs: Set<string>,
  power: PowerControl,
  jobs: readonly JobFile[],
): Promise<void> {
  if (busy() !== undefined) return;
  // A running agent task is busy even when no turn streams (a tool may be
  // mid-download); `runningJobs` holds it for the whole detached run (AC11).
  if (runningJobs.size > 0) return;
  const anySleepIfIdle = jobs.some((jf) => jf.job.enabled && jf.job.after === 'sleep_if_idle');
  if (!anySleepIfIdle) return;
  const msSinceInput = await power.idleSinceResume();
  if (msSinceInput === null) return;
  // Anchor on the last input: untouched since the resume, the machine may sleep again.
  const input: SleepIfIdleInput = {
    msSinceResume: 0,
    msSinceInput,
    busy: busy(),
  };
  if (shouldSleepIfIdle(input)) {
    await power.suspend().catch(() => undefined);
  }
}
