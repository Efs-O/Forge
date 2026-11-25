/**
 * The job state file's own module: its baseline, and the read-modify-write
 * merge `JobStore.patchState` performs. Moved out of `JobStore.ts` (pure move —
 * no behaviour change) so the store keeps room for the async rename budget.
 */

import { JobStateSchema, type JobState } from './jobSchema';

/** The default state for a job that has never run. */
export function defaultState(): JobState {
  return {
    last_run_at: null,
    last_ok_at: null,
    last_observation: null,
    consecutive_failures: 0,
    next_due_at: null,
    conversation_id: null,
    summary_pending: false,
    summary_failures: 0,
    summary_retry_at: null,
    task_run: null,
    task_pending: false,
    task_pending_reason: null,
    task_pending_since: null,
    task_pending_observation: null,
  };
}

/**
 * The state a state file's text describes: parsed and validated, or a fresh
 * baseline when the text is not JSON at all or does not fit the schema. State
 * corruption is recoverable everywhere in this store: a malformed state merely
 * makes the next job run establish a new baseline.
 */
export function parseStateOrBaseline(raw: string): JobState {
  try {
    const result = JobStateSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : defaultState();
  } catch (err) {
    if (err instanceof SyntaxError) return defaultState();
    throw err;
  }
}

/** Merge `patch` into the state the file holds and serialise it the way the
 *  store writes it: 2-space JSON with a trailing newline. */
export function mergedStateJson(raw: string, patch: Partial<JobState>): string {
  const next = JobStateSchema.parse({ ...parseStateOrBaseline(raw), ...patch });
  return `${JSON.stringify(next, null, 2)}\n`;
}
