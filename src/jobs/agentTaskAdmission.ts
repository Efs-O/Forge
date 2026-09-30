import type { JobStore } from './JobStore';
import type { IBackendPool } from '../backend/poolTypes';
import { nextDue } from './schedule';
import type { JobFile, Schedule } from './jobSchema';

/**
 * Decide whether a slot is free for the job to start now (step 1). The job does
 * not wait for full idle: it starts when its model is usable, enough parallel
 * slots are free, and its own conversation is not streaming.
 */
export function canStartNow(
  jobModel: string,
  ownConversationId: string | null,
  pool: IBackendPool,
  streamingConversationIds: readonly string[],
): { start: boolean; reason: string } {
  const streaming = streamingConversationIds.length;
  const others = pool.loadedModelsExcept(jobModel);

  // Hard wait: its own chat is busy (two turns in one conversation interleave).
  if (ownConversationId !== null && streamingConversationIds.includes(ownConversationId)) {
    return { start: false, reason: 'its own conversation is streaming' };
  }
  // Hard wait: another model is loaded and a chat is streaming. The job may not
  // unload it mid-turn, and loading beside it spills VRAM (2026-09-23: two
  // resident models plus a job's third server took every GPU down).
  if (others.length > 0 && streaming > 0) {
    return { start: false, reason: `another model (${others.join(', ')}) is in use` };
  }
  // Nothing else streams: step 3 unloads every other model before the turn.
  const capacity = pool.parallelCapacity(jobModel);
  if (streaming >= capacity) {
    return { start: false, reason: `all ${capacity} parallel slot(s) are streaming` };
  }
  return { start: true, reason: '' };
}

/**
 * How long the user's own chats must have been quiet before a job may start.
 * `canStartNow` only sees a turn while it streams; between two turns of a long
 * session the box looks idle, and a job that starts there holds the model (or
 * swaps it) under the user's next message.
 */
export const USER_QUIET_MS = 10 * 60_000;

/**
 * The reason to wait when a conversation that is not a job's own was updated
 * within `USER_QUIET_MS`, or undefined when the user has been quiet long enough.
 */
export function userQuietGate(
  conversations: readonly { id: string; updatedAt: number }[],
  jobConversationIds: ReadonlySet<string>,
  now: number,
): string | undefined {
  let last = 0;
  for (const c of conversations) {
    if (!jobConversationIds.has(c.id) && c.updatedAt > last) last = c.updatedAt;
  }
  const ago = now - last;
  if (ago >= USER_QUIET_MS) return undefined;
  return `the user was active ${Math.floor(ago / 60_000)} min ago`;
}

/** The nominal period between ticks (ms) — the `task_pending` TTL bound. */
export function schedulePeriodMs(schedule: Schedule, now: number): number {
  switch (schedule.kind) {
    case 'interval':
      return schedule.minutes * 60_000;
    case 'daily':
    case 'weekly':
      return Math.max(60_000, nextDue(schedule, new Date(now)).getTime() - now);
  }
}

/** The state patch that clears the `task_pending` bookkeeping fields. */
export const CLEAR_PENDING = {
  task_pending: false,
  task_pending_since: null,
  task_pending_observation: null,
} as const;

/**
 * The busy branch of the runner's `run()`: when the slot is not free, either
 * drop a pending task older than one schedule period (the `task_pending` TTL)
 * or defer it, recording the observation for the next tick. Always ends the
 * run (the caller returns after this).
 */
export async function deferBusyTask(
  store: JobStore,
  jobFile: JobFile,
  startedAt: number,
  wasLate: boolean,
): Promise<void> {
  const { job, state } = jobFile;
  // Drop a pending task older than one schedule period (the task_pending TTL).
  if (state.task_pending && state.task_pending_since !== null) {
    const period = schedulePeriodMs(job.schedule, startedAt);
    if (startedAt - state.task_pending_since >= period) {
      // Advance to the next scheduled time, or the very next tick re-checks,
      // pends again and the TTL never takes effect.
      store.patchState(job.id, {
        ...CLEAR_PENDING,
        next_due_at: nextDue(job.schedule, new Date(startedAt)).getTime(),
      });
      await store.appendRun(job.id, {
        at: startedAt,
        late: wasLate,
        outcome: 'skipped',
        changed: false,
        summary: `skipped: busy (pending ${Math.round((startedAt - state.task_pending_since) / 60000)} min)`,
        delivered: 0,
      });
      return;
    }
  }
  store.patchState(job.id, {
    task_pending: true,
    task_pending_since: state.task_pending ? state.task_pending_since : startedAt,
    // The observation handed over by this tick: the fresh check's, or on a
    // retry the one saved here when the task was first deferred.
    task_pending_observation: state.last_observation,
  });
}
