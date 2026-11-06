/**
 * Human-readable forms of a job's schedule, check, on_change policy, action,
 * and timestamps. Shared by the `manage_jobs` tool (B2) and the Telegram
 * `/jobs` and `/job` commands (B3) so the two surfaces never describe the same
 * job differently.
 */

import type { Job, JobFile, JobState } from './jobSchema';

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
    case 'hf_discussion':
      return `hf_discussion ${check.repo}#${check.discussion_number}`;
    case 'disk_space':
      return `disk_space ${check.path} (min ${check.min_free_gb} GB free)`;
    case 'tool_usage':
      return 'tool_usage (daily files in ~/.forge/tool-usage/, about 5 KB a day)';
    case 'none':
      return 'none (runs every tick)';
  }
}

/** A short human-readable form of an on_change policy. */
export function describeOnChange(onChange: Job['on_change']): string {
  return onChange.kind === 'notify' ? 'notify' : `summarize (${onChange.focus.join(', ')})`;
}

/** A short human-readable form of an action. */
export function describeAction(action: NonNullable<Job['action']>): string {
  switch (action.kind) {
    case 'llamacpp_update':
      return `llamacpp_update [${action.mode}]`;
    case 'agent_task':
      return `agent_task [${action.report}]${action.model ? ` (${action.model})` : ''}${action.max_minutes ? ` (max ${action.max_minutes}m)` : ''}`;
    case 'retitle':
      return `retitle [${action.report}]${action.dry_run ? ' (dry run)' : ''} (at most ${action.max_chats} chats, skip chats idle under ${action.min_idle_minutes}m${
        action.reassess_ids.length
          ? `, re-asking ${action.reassess_ids.length} already-named chats`
          : ''
      })${action.model ? ` (${action.model})` : ''}`;
  }
}

/** Format an epoch-ms timestamp relative to `now`, for list/get output. */
export function formatWhen(epochMs: number, now: Date): string {
  const then = new Date(epochMs);
  const diff = now.getTime() - epochMs;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return future ? 'now' : 'just now';
  // A minute-scale gap read `0h ago` before this branch existed. The sessions
  // panel shows these every minute, so minutes get their own line; a future
  // time is phrased as one, not as a past tense.
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
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

/** The outcome of the most recent run, or 'no runs yet'. */
export function lastRunOutcome(state: JobState): string {
  if (state.last_run_at === null) return 'no runs yet';
  if (state.consecutive_failures > 0) return `failing ×${state.consecutive_failures}`;
  return 'ok';
}

/** A human-readable description of a whole job (for `get`). */
export function describeJob(jobFile: JobFile): string {
  const { job, state } = jobFile;
  const lines = [
    `Job "${job.name}" [${job.id}]`,
    `  status: ${job.enabled ? 'enabled' : 'paused'}${state.task_pending && state.task_pending_reason ? ` · pending: ${state.task_pending_reason}` : ''}`,
    `  schedule: ${describeSchedule(job.schedule)}`,
    `  check: ${describeCheck(job.check)}`,
    `  on_change: ${describeOnChange(job.on_change)}`,
    `  action: ${job.action ? describeAction(job.action) : 'none'}`,
    `  wake: ${job.wake ? `yes (${job.after})` : 'no'}`,
    `  last run: ${state.last_run_at === null ? 'never' : formatWhen(state.last_run_at, new Date())}`,
    `  last ok: ${state.last_ok_at === null ? 'never' : formatWhen(state.last_ok_at, new Date())}`,
    `  consecutive failures: ${state.consecutive_failures}`,
    `  next due: ${state.next_due_at === null ? 'not scheduled' : formatWhen(state.next_due_at, new Date())}`,
  ];
  if (state.last_observation) {
    lines.push(`  last observation: ${truncate(state.last_observation, 400)}`);
  }
  return lines.join('\n');
}
