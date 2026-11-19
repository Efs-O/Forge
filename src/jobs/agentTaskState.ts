import * as fs from 'fs';
import * as path from 'path';
import type { JobStore } from './JobStore';
import { writeOutboxItem } from './JobOutbox';
import { describeError } from '../util/describeError';
import { writeFileAtomic } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import type { JobFile, JobState } from './jobSchema';

/**
 * The durable state an agent-task run leaves behind: the config.yaml backup
 * and the `task_run` marker. Kept apart from the runner so the snapshot, the
 * phase-4 rollback and crash recovery all name one backup path.
 */

/** Where a run's config.yaml snapshot lives: `state/<id>.config.bak`. */
export function configBackupPath(store: JobStore, jobId: string): string {
  return backupInStateDir(path.join(store.root, 'state'), jobId);
}

function backupInStateDir(stateDir: string, jobId: string): string {
  return path.join(stateDir, `${jobId}.config.bak`);
}

/** Remove the agent-task config snapshot when its owning job is deleted. */
export async function removeConfigBackup(stateDir: string, jobId: string): Promise<void> {
  await fs.promises
    .unlink(backupInStateDir(stateDir, jobId))
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
}

/**
 * Step 4: snapshot config.yaml's bytes to `state/<id>.config.bak` (the rollback
 * source for step 7). A missing config is not fatal; rollback simply has
 * nothing to restore. Any other failure throws: the task must not go on to
 * change config with no backup to roll back to.
 */
export async function snapshotConfig(
  store: JobStore,
  configPath: string | undefined,
  jobId: string,
): Promise<string | undefined> {
  if (!configPath) return undefined;
  const backupPath = configBackupPath(store, jobId);
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read config.yaml to back it up: ${describeError(error)}`);
  }
  try {
    await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
    await writeFileAtomic(backupPath, bytes);
  } catch (error) {
    throw new Error(`Could not back up config.yaml: ${describeError(error)}`);
  }
  return backupPath;
}

/** How often a running agent task refreshes `task_run.heartbeat_at`. */
const TASK_RUN_HEARTBEAT_MS = 30_000;
/** A `task_run` not refreshed for this long belongs to a window that died. */
const TASK_RUN_STALE_MS = 120_000;

/**
 * Keep a run's `task_run` marker fresh so a scheduler that takes the lease over
 * while this window is still alive leaves the run alone.
 *
 * Two rules exist because the caller cannot stop the beat at the exact moment
 * the marker is cleared: `finish()` releases the model and delivers the report
 * before it clears the marker, and the beat is the only thing keeping another
 * window's scheduler from calling a finished run interrupted. So (1) every beat
 * re-reads the state and patches only while the marker still names THIS run's
 * `started_at` - a marker that is gone, or belongs to a newer run, is left
 * alone; and (2) stopping the beat clears the marker once more, in case a beat
 * that had already read the state lands after the clear and puts it back.
 *
 * The stop function takes one argument: whether the run's own `finish()` got
 * through. `false` stops the beat but leaves the marker, because nothing wrote
 * the run's row or its notice — recovery is then what reports it, as it would
 * for any dead window. Clearing the marker on a failed finish would drop the
 * run from the record entirely.
 */
export function startTaskRunHeartbeat(
  store: JobStore,
  jobId: string,
  startedAt: number,
  conversationId: () => string | null,
  now: () => number,
): (finished?: boolean) => void {
  let stopped = false;
  /** True while the marker on disk still belongs to this run. */
  const stillOurs = async (): Promise<boolean> => {
    const fresh = await store.load(jobId);
    return fresh?.state.task_run?.started_at === startedAt;
  };
  const beat = async (): Promise<void> => {
    try {
      if (!(await stillOurs())) return;
      // The read above is an await: the run can finish while it is in flight.
      if (stopped) return;
      store.patchState(jobId, {
        task_run: { started_at: startedAt, conversation_id: conversationId(), heartbeat_at: now() },
      });
    } catch {
      // A missed beat only ages the marker; the next one retries.
    }
  };
  const timer = setInterval(() => void beat(), TASK_RUN_HEARTBEAT_MS);
  return (finished = true) => {
    stopped = true;
    clearInterval(timer);
    if (!finished) return;
    void stillOurs()
      .then((ours) => {
        if (ours) store.patchState(jobId, { task_run: null });
      })
      .catch(() => undefined);
  };
}

/** Whether a `task_run` marker is still being refreshed by a live window. */
function taskRunIsLive(state: JobState, now: number): boolean {
  const run = state.task_run;
  if (!run) return false;
  return now - (run.heartbeat_at ?? run.started_at) < TASK_RUN_STALE_MS;
}

/**
 * Crash / reload recovery (CI-enforced). A job whose state still holds a
 * `task_run` that nobody refreshes was running when the window that started it
 * stopped beating — its process may have died, or only stopped writing the
 * marker — so report it through the outbox, record a `failed` run row, and
 * clear the marker. Not retried automatically; the next tick runs it.
 * Idempotent, and each job is re-read before it is acted on, since the list
 * above is a snapshot taken at the start of the tick.
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
    // Everything above is a snapshot taken at the start of the tick. Re-read the
    // job before acting on it: the run may have finished and cleared its marker
    // while this loop read the other jobs, and a marker that started beating
    // again in the meantime belongs to a window that is alive right now.
    const fresh = await store.load(job.id);
    const run = fresh?.state.task_run;
    if (!fresh || !run) continue;
    if (taskRunIsLive(fresh.state, now())) continue;
    const started = new Date(run.started_at);
    const hhmm = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;
    // What Forge actually knows is that the beat stopped. Whether the window
    // restarted, exited or merely stopped responding is not something a stale
    // marker can tell, and the sentence this used to say asserted the one case
    // that is least likely - a run whose window died mid-report leaves no
    // `session_start` behind, so "Forge restarted" is a guess the owner cannot
    // check against a log that says nothing of the kind.
    const silentMin = Math.max(
      1,
      Math.round((now() - (run.heartbeat_at ?? run.started_at)) / 60_000),
    );
    const sentence =
      `interrupted — no heartbeat for ${silentMin} min; the run's window stopped ` +
      `responding or exited (started ${hhmm})`;
    const backupPath = configBackupPath(store, job.id);
    const delivered = await writeOutboxItem(
      outboxDir,
      job.id,
      job.name,
      `${sentence}; config.yaml backup kept at ${backupPath}`,
      now(),
    ).then(
      () => 1,
      (error: unknown) => {
        getLogger().warn(
          `[AgentTask] interrupted-run notice for "${job.name}" not delivered: ${describeError(error)}`,
        );
        return 0;
      },
    );
    await store
      .appendRun(job.id, {
        at: now(),
        late: false,
        outcome: 'failed',
        changed: false,
        summary: sentence,
        error: sentence,
        delivered,
      })
      .catch(() => undefined);
    store.patchState(job.id, { task_run: null });
    cleared.add(job.id);
  }
  return cleared;
}
