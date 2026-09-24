import * as path from 'path';
import type { JobStore } from './JobStore';
import { writeOutboxItem } from './JobOutbox';
import type { JobFile, JobState } from './jobSchema';

/**
 * The durable state an agent-task run leaves behind: the config.yaml backup
 * and the `task_run` marker. Kept apart from the runner so the snapshot, the
 * phase-4 rollback and crash recovery all name one backup path.
 */

/** Where a run's config.yaml snapshot lives: `state/<id>.config.bak`. */
export function configBackupPath(store: JobStore, jobId: string): string {
  return path.join(store.root, 'state', `${jobId}.config.bak`);
}

/** How often a running agent task refreshes `task_run.heartbeat_at`. */
export const TASK_RUN_HEARTBEAT_MS = 30_000;
/** A `task_run` not refreshed for this long belongs to a window that died. */
export const TASK_RUN_STALE_MS = 120_000;

/**
 * Keep a run's `task_run` marker fresh so a scheduler that takes the lease
 * over while this window is still alive leaves the run alone. Returns the stop
 * function; call it before the marker is cleared.
 */
export function startTaskRunHeartbeat(
  store: JobStore,
  jobId: string,
  startedAt: number,
  conversationId: () => string | null,
  now: () => number,
): () => void {
  const timer = setInterval(() => {
    try {
      store.patchState(jobId, {
        task_run: { started_at: startedAt, conversation_id: conversationId(), heartbeat_at: now() },
      });
    } catch {
      // A missed beat only ages the marker; the next one retries.
    }
  }, TASK_RUN_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/** Whether a `task_run` marker is still being refreshed by a live window. */
export function taskRunIsLive(state: JobState, now: number): boolean {
  const run = state.task_run;
  if (!run) return false;
  return now - (run.heartbeat_at ?? run.started_at) < TASK_RUN_STALE_MS;
}

/**
 * Crash / reload recovery (CI-enforced). A job whose state still holds a
 * `task_run` that nobody refreshes was running when its window died: report it
 * through the outbox, record a `failed` run row, and clear the marker. Not
 * retried automatically — the next tick runs it. Idempotent.
 *
 * A marker this window owns (`isOwn`) or one still heartbeating is left alone:
 * the scheduler lease can move to another window while the old one is alive
 * (an extension host blocked past the lease timeout), and clearing its marker
 * would let the new owner start the same task a second time.
 *
 * Returns the ids it cleared; `jobs` lets a tick pass the files it already read.
 */
export async function recoverInterruptedRuns(
  store: JobStore,
  outboxDir: string,
  now: () => number,
  options: { jobs?: JobFile[]; isOwn?: (jobId: string) => boolean } = {},
): Promise<Set<string>> {
  const jobs = options.jobs ?? (await store.loadAll());
  const cleared = new Set<string>();
  for (const { job, state } of jobs) {
    if (!state.task_run) continue;
    if (options.isOwn?.(job.id) || taskRunIsLive(state, now())) continue;
    const started = new Date(state.task_run.started_at);
    const hhmm = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;
    const backupPath = configBackupPath(store, job.id);
    await writeOutboxItem(
      outboxDir,
      job.id,
      job.name,
      `interrupted — Forge restarted during the run (started ${hhmm}); ` +
        `config.yaml backup kept at ${backupPath}`,
      now(),
    ).catch(() => undefined);
    await store
      .appendRun(job.id, {
        at: now(),
        late: false,
        outcome: 'failed',
        changed: false,
        summary: 'interrupted — Forge restarted during the run',
        error: 'interrupted — Forge restarted during the run',
        delivered: 1,
      })
      .catch(() => undefined);
    store.patchState(job.id, { task_run: null });
    cleared.add(job.id);
  }
  return cleared;
}
