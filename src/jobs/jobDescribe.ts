/**
 * Human-readable forms of a job's schedule, check, on_change policy, action,
 * and timestamps. Shared by the `manage_jobs` tool (B2) and the Telegram
 * `/jobs` and `/job` commands (B3) so the two surfaces never describe the same
 * job differently.
 */

import type { Job } from './jobSchema';

/** A short human-readable form of a schedule. */
export function describeSchedule(schedule: Job['schedule']): string {
  switch (schedule.kind) {
    case 'interval':
      return `every ${schedule.minutes} min`;
    case 'daily':
      return `daily at ${schedule.at}`;
    case 'weekly':
      return `weekly on ${schedule.days.join('/')} at ${schedule.at}`;
  }
}

/** A short human-readable form of a check. */
export function describeCheck(check: Job['check']): string {
  switch (check.kind) {
    case 'github_release':
      return `github_release ${check.repo}${check.asset_pattern ? ` (asset ${check.asset_pattern})` : ''}`;
    case 'github_issue':
      return `github_issue ${check.repo}#${check.issue_number}`;
    case 'disk_space':
      return `disk_space ${check.path} (min ${check.min_free_gb} GB free)`;
  }
}

/** A short human-readable form of an on_change policy. */
export function describeOnChange(onChange: Job['on_change']): string {
  return onChange.kind === 'notify' ? 'notify' : `summarize (${onChange.focus.join(', ')})`;
}

/** A short human-readable form of an action. */
export function describeAction(action: NonNullable<Job['action']>): string {
  return `${action.kind} [${action.mode}]`;
}

/** Format an epoch-ms timestamp relative to `now`, for list/get output. */
export function formatWhen(epochMs: number, now: Date): string {
  const then = new Date(epochMs);
  const diff = now.getTime() - epochMs;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return future ? 'now' : 'just now';
  const hours = Math.round(abs / 3_600_000);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(abs / 86_400_000);
  if (days < 7) return future ? `in ${days}d` : `${days}d ago`;
  return then.toLocaleDateString();
}

/** Truncate a string to `max` characters, adding an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
