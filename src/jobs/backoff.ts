import { nextDue } from './schedule';
import type { Schedule } from './jobSchema';

/** Consecutive failures before a job is backed off (B.3). */
export const BACKOFF_THRESHOLD = 3;
/** The maximum backoff interval (B.3). */
export const MAX_BACKOFF_MS = 24 * 60 * 60_000;

/** Compute the next due time after a run, applying the shared failure backoff. */
export function nextDueWithBackoff(
  schedule: Schedule,
  now: Date,
  consecutiveFailures: number,
): number {
  const nowMs = now.getTime();
  const scheduledDue = nextDue(schedule, now).getTime();
  if (consecutiveFailures < BACKOFF_THRESHOLD) return scheduledDue;
  const scheduledIntervalMs = Math.max(60_000, scheduledDue - nowMs);
  const backoffMs = Math.min(
    MAX_BACKOFF_MS,
    scheduledIntervalMs * 2 ** (consecutiveFailures - BACKOFF_THRESHOLD + 1),
  );
  return nowMs + backoffMs;
}
