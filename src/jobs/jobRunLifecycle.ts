/**
 * The per-job run-lifecycle leaf functions of the scheduler, extracted from
 * `JobScheduler` (pure move — no behaviour change). These are the three
 * concerns `runJob` delegates to that are distinct from the tick/lease core:
 * running a check, applying backoff after a failure, and the D6 sleep-if-idle
 * re-suspend. Each takes only the injected deps it needs (the scheduler's
 * fields are private, so the class passes them at the call site).
 */

import type { JobFile } from './jobSchema';
import type { JobStore } from './JobStore';
import type { JobDelivery } from './JobDelivery';
import { runCheck, buildCheckContext } from './checks/runCheck';
import { nextDueWithBackoff, BACKOFF_THRESHOLD } from './backoff';
import {
  shouldSleepIfIdle,
  type PowerControl,
  type SleepIfIdleInput,
} from '../system/PowerControl';
import type { LlamacppAction } from './actions/llamacppAction';

/** The result of running a job's check. */
export interface CheckOutcome {
  observation: string | null;
  changed: boolean;
  summary: string;
}

/** Run the check. Returns the observation, whether it changed, and a summary. */
export async function runJobCheck(
  getConfig: () => { allowedHosts: readonly string[]; maxConcurrent: number },
  etagCache: Map<string, string>,
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
  if (count === BACKOFF_THRESHOLD) {
    await delivery.deliver(job, `failing: ${message}`).catch(() => undefined);
  }
  await store.appendRun(job.id, {
    at: at.getTime(),
    late: false,
    outcome: 'skipped',
    changed: false,
    summary: `backed off after ${count} failures: ${message}`,
    delivered: 0,
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
