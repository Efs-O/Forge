import type { RecurringWake } from '../system/wakeTaskXml';
import { WAKE_LEAD_MS } from '../system/PowerControl';
import type { Job, JobState, Schedule, Weekday } from './jobSchema';

/**
 * The pure scheduling half of the job scheduler: computing when a job is next
 * due and what wake times to register. Split from the tick loop so every
 * branch is testable with a fake clock — no lease, no store, no power.
 *
 * All times are local. The machine is a single-location box; a job that runs
 * at "06:00" means 06:00 local, whatever the timezone says. DST is handled by
 * always computing from the wall clock of `now`, not by storing an absolute
 * UTC instant.
 */

const WEEKDAY_ORDER: readonly Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Map a JS `getDay()` (0=Sun) to the plan's `Weekday`. */
export function jsDayToWeekday(jsDay: number): Weekday {
  return WEEKDAY_ORDER[(jsDay + 6) % 7]!;
}

/**
 * The next time a schedule is due, strictly after `from`.
 *
 * - `interval`: `from + minutes`.
 * - `daily`: the next occurrence of `at` (today if still ahead, else tomorrow).
 * - `weekly`: the next occurrence of `at` on any of `days`.
 */
export function nextDue(schedule: Schedule, from: Date): Date {
  switch (schedule.kind) {
    case 'interval': {
      return new Date(from.getTime() + schedule.minutes * 60_000);
    }
    case 'daily':
      return nextClockTime(schedule.at, from, undefined);
    case 'weekly':
      return nextClockTime(schedule.at, from, schedule.days);
  }
}

/** Parse `HH:MM` into hours and minutes. */
function parseClock(at: string): { hour: number; minute: number } {
  const [h, m] = at.split(':');
  return { hour: Number(h), minute: Number(m) };
}

/**
 * The next occurrence of a clock time, optionally constrained to a set of
 * weekdays. Advances day by day (at most 7) until the wall clock and weekday
 * both match.
 */
function nextClockTime(at: string, from: Date, days: readonly Weekday[] | undefined): Date {
  const { hour, minute } = parseClock(at);
  const candidate = new Date(from);
  candidate.setHours(hour, minute, 0, 0);
  // Strictly after `from`: if the candidate is not yet ahead, push to the next day.
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
  if (!days) return candidate;
  // Advance until the weekday is one of the wanted days (at most 7 iterations).
  for (let i = 0; i < 7; i++) {
    if (days.includes(jsDayToWeekday(candidate.getDay()))) return candidate;
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate; // unreachable: a wanted weekday is always within 7 days
}

/**
 * The local trigger times to register in the recurring wake task for a set of
 * enabled, `wake: true` jobs. Each job contributes its next due time, shifted
 * earlier by `WAKE_LEAD_MS` so the machine is awake before the job fires.
 *
 * A shift across midnight also shifts a weekly wake to the preceding weekday
 * (a weekly 00:01 job with a 2-minute lead wakes at 23:59 the day before).
 * Times are deduplicated: two jobs due at the same minute produce one trigger.
 */
export function wakeTimesFor(
  jobs: readonly Job[],
  now: Date,
  wakeLeadMs: number = WAKE_LEAD_MS,
): RecurringWake[] {
  const wakes = new Map<string, RecurringWake>();
  for (const job of jobs) {
    // Interval jobs have no stable calendar trigger, so they cannot arm an
    // RTC wake. They still run normally when Forge is awake.
    if (!job.enabled || !job.wake || job.schedule.kind === 'interval') continue;
    const dueDays: readonly Weekday[] =
      job.schedule.kind === 'weekly' ? job.schedule.days : WEEKDAY_ORDER;
    for (const day of dueDays) {
      // Use a concrete occurrence of every configured weekday, not merely the
      // next one. A recurring Task Scheduler trigger must cover the whole
      // weekly schedule.
      const due = nextClockTime(job.schedule.at, now, [day]);
      const fire = new Date(due.getTime() - wakeLeadMs);
      const hour = fire.getHours();
      const minute = fire.getMinutes();
      const key = `${hour}:${minute}`;
      const prior = wakes.get(key);
      if (job.schedule.kind === 'daily' || prior?.days === 'daily') {
        wakes.set(key, { hour, minute, days: 'daily' });
      } else {
        const days = new Set([...(prior?.days ?? []), jsDayToWeekday(fire.getDay())]);
        wakes.set(key, {
          hour,
          minute,
          days: WEEKDAY_ORDER.filter((candidate) => days.has(candidate)),
        });
      }
    }
  }
  return [...wakes.values()];
}

/**
 * Whether a job is due to run now. A job is due when `now` is at or past its
 * `next_due_at`. Backoff is encoded in `next_due_at` itself (a backed-off job's
 * next due is pushed out), so no separate flag is needed. A job that fell due
 * while the machine was off (or VS Code closed) is still due — it runs once,
 * marked `late` by the caller.
 */
export function isDue(state: JobState, now: Date): boolean {
  if (state.next_due_at === null) return true;
  return now.getTime() >= state.next_due_at;
}
