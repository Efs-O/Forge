import * as path from 'path';
import type { JobStore } from './JobStore';
import { writeOutboxItem } from './JobOutbox';

/**
 * The durable state an agent-task run leaves behind: the config.yaml backup
 * and the `task_run` marker. Kept apart from the runner so the snapshot, the
 * phase-4 rollback and crash recovery all name one backup path.
 */

/** Where a run's config.yaml snapshot lives: `state/<id>.config.bak`. */
export function configBackupPath(store: JobStore, jobId: string): string {
  return path.join(store.root, 'state', `${jobId}.config.bak`);
}

/**
 * Crash / reload recovery (CI-enforced). On `start()`, any job whose state
 * still holds a `task_run` was running when Forge died: report it through the
 * outbox, record a `failed` run row, and clear the marker. Not retried
 * automatically — the next tick runs it. Idempotent.
 */
export async function recoverInterruptedRuns(
  store: JobStore,
  outboxDir: string,
  now: () => number,
): Promise<void> {
  const jobs = await store.loadAll();
  for (const { job, state } of jobs) {
    if (!state.task_run) continue;
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
  }
}
