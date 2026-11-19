/**
 * The `manage_jobs` action bodies: what each action does to the store and what
 * it reports back. Split out of `jobTools.ts`, which keeps the tool definition,
 * the permission, approval and refuse-before-approval gates and the CLI-consent
 * check; only `runManageJobs` (and the `ACTIONS` list the gates read) cross back.
 * only `runManageJobs` (and the `ACTIONS` list the gates read) cross back.
 */

import * as vscode from 'vscode';
import { defaultState } from '../jobs/JobStore';
import { JobSchema, type JobFile } from '../jobs/jobSchema';
import { exactJobIdRefusal, resolveJobRef } from '../jobs/jobRefResolver';
import { uniqueJobId } from '../jobs/jobId';
import { appendHomeNote } from '../jobs/jobsHome';
import { nextDue } from '../jobs/schedule';
import { jobCreateText } from '../jobs/jobCreateText';
import { describeJob, describeSchedule, formatWhen, lastRunOutcome } from '../jobs/jobDescribe';
import { describeUpdatedFields } from '../jobs/jobDescribe';
import { openDiscussChat } from '../jobs/jobDiscuss';
import { pinAgentTaskModel } from '../config/jobsSchema';
import { describeToolIssues } from './toolErrorText';
import type { ManageJobsDeps } from './jobTools';

/** The actions `manage_jobs` can perform. */
export const ACTIONS = [
  'list',
  'get',
  'create',
  'update',
  'pause',
  'resume',
  'delete',
  'run_now',
  'discuss',
] as const;
export type Action = (typeof ACTIONS)[number];

/** The job fields `update` may change (everything except the id). */
const UPDATABLE_KEYS = [
  'name',
  'enabled',
  'wake',
  'after',
  'schedule',
  'check',
  'on_change',
  'action',
];

export async function runManageJobs(
  deps: ManageJobsDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const rawAction = args['action'];
  if (typeof rawAction !== 'string' || !ACTIONS.includes(rawAction as Action)) {
    throw new Error(`manage_jobs: action must be one of ${ACTIONS.join(', ')}.`);
  }
  const action = rawAction as Action;

  if (action === 'list') return listJobs(deps);

  if (action === 'create') return createJob(deps, args);

  // Every other action needs a resolvable job.
  const ref = args['job'];
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new Error(`manage_jobs: \`job\` (id or name) is required for ${action}.`);
  }
  const all = await deps.store.loadAll();
  if (action !== 'get') {
    // The Undo copy names the file `job` says, so a change takes the exact id.
    const refusal = exactJobIdRefusal(all, ref, action);
    if (refusal) throw new Error(refusal);
  }
  const match = resolveJobRef(all, ref);
  if (match.kind === 'none') {
    throw new Error(
      `manage_jobs: no job matches "${ref}". List the jobs with {action:"list"} to see the ids and names.`,
    );
  }
  if (match.kind === 'ambiguous') {
    const names = match.candidates.map((jf) => `${jf.job.name} (${jf.job.id})`).join(', ');
    throw new Error(
      `manage_jobs: "${ref}" is ambiguous — it matches: ${names}. Use the exact id to pick one.`,
    );
  }

  switch (action) {
    case 'get':
      return describeJob(match.jobFile);
    case 'update':
      return updateJob(deps, match.jobFile, args);
    case 'pause':
      return setEnabled(deps, match.jobFile, false);
    case 'resume':
      return setEnabled(deps, match.jobFile, true);
    case 'delete':
      await deps.store.delete(match.jobFile.job.id);
      return `Deleted job "${match.jobFile.job.name}" (${match.jobFile.job.id}).`;
    case 'run_now': {
      await deps.store.requestRun(match.jobFile.job.id);
      return appendHomeNote(
        `Run requested for "${match.jobFile.job.name}" (${match.jobFile.job.id}). It will run on the next scheduler tick, in whichever window holds the jobs lease.`,
        deps.getConfig(),
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      );
    }
    case 'discuss':
      return discussJob(deps, match.jobFile);
    default:
      throw new Error(`manage_jobs: unhandled action "${action}".`);
  }
}

/** One line per job: name, enabled, schedule, last run and outcome, next due. */
async function listJobs(deps: ManageJobsDeps): Promise<string> {
  const all = await deps.store.loadAll();
  if (all.length === 0) {
    return 'No jobs are defined. Create one with {action:"create","definition":{...}}.';
  }
  const now = (deps.now ?? (() => new Date()))();
  const lines = all.map((jf) => {
    const { job, state } = jf;
    const status = job.enabled ? 'enabled' : 'paused';
    const pending =
      state.task_pending && state.task_pending_reason
        ? ` · pending: ${state.task_pending_reason}`
        : '';
    const last = state.last_run_at === null ? 'never' : formatWhen(state.last_run_at, now);
    const outcome = lastRunOutcome(state);
    const next =
      state.next_due_at === null
        ? 'not scheduled'
        : job.enabled
          ? `next ${formatWhen(state.next_due_at, now)}`
          : 'paused';
    return `- ${job.name} [${job.id}] — ${status}${pending} · ${describeSchedule(job.schedule)} · last ${last} (${outcome}) · ${next}`;
  });
  return lines.join('\n');
}

/** Create a job from a full definition. The id is generated; the name is required. */
async function createJob(deps: ManageJobsDeps, args: Record<string, unknown>): Promise<string> {
  const raw = args['definition'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('manage_jobs: `create` requires an object `definition`.');
  }
  const partial = raw as Record<string, unknown>;
  if (typeof partial['name'] !== 'string' || !partial['name'].trim()) {
    throw new Error('manage_jobs: a new job needs a `name`.');
  }
  const existing = await deps.store.loadAll();
  const taken = new Set(existing.map((jf) => jf.job.id));
  const id = uniqueJobId(partial['name'] as string, taken);
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const candidate: Record<string, unknown> = {
    version: 1,
    id,
    name: partial['name'],
    enabled: partial['enabled'] ?? true,
    wake: partial['wake'] ?? false,
    after: partial['after'] ?? 'stay_awake',
    schedule: partial['schedule'],
    check: partial['check'],
    on_change: partial['on_change'],
    action: pinAgentTaskModel(partial['action'] ?? null, deps.getConfig()),
    created_at: nowMs,
    updated_at: nowMs,
  };
  const result = JobSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      [
        'manage_jobs: invalid job definition:',
        ...describeToolIssues('manage_jobs', result.error.issues, candidate),
      ].join('\n'),
    );
  }
  assertWakeSupported(result.data.wake, deps.platform ?? process.platform);
  await deps.store.saveJob(result.data);
  // A state with no `next_due_at` is due at once, so a new "daily at 08:20"
  // job fired on the next tick (2026-09-23, 15:53). Seed its first run time.
  const firstRun = nextDue(result.data.schedule, now);
  await deps.store.saveState(id, { ...defaultState(), next_due_at: firstRun.getTime() });
  return jobCreateText(result.data, id, firstRun, deps.getConfig());
}

/** Apply a partial definition to an existing job; the id is never edited. */
async function updateJob(
  deps: ManageJobsDeps,
  jobFile: JobFile,
  args: Record<string, unknown>,
): Promise<string> {
  const raw = args['definition'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('manage_jobs: `update` requires an object `definition`.');
  }
  const partial = raw as Record<string, unknown>;
  const unknown = Object.keys(partial).filter((key) => !UPDATABLE_KEYS.includes(key));
  if (unknown.length) throw new Error(`manage_jobs: update cannot set: ${unknown.join(', ')}.`);
  const { id, ...current } = jobFile.job;
  const merged: Record<string, unknown> = { ...current };
  for (const key of UPDATABLE_KEYS) {
    if (partial[key] !== undefined) merged[key] = partial[key];
  }
  // A replaced action gets the create-time pin, or it follows chat-tab model switches (U16-02).
  if (partial['action'] !== undefined) {
    merged['action'] = pinAgentTaskModel(partial['action'], deps.getConfig());
  }
  merged['updated_at'] = Date.now();
  const candidate = { ...merged, id };
  const result = JobSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      [
        'manage_jobs: update rejected:',
        ...describeToolIssues('manage_jobs', result.error.issues, candidate),
      ].join('\n'),
    );
  }
  assertWakeSupported(result.data.wake, deps.platform ?? process.platform);
  await deps.store.saveJob(result.data);
  // A new schedule must move the next run too: the scheduler only reads
  // `next_due_at`, so "run at 09:00 instead" otherwise fired once more at the
  // old time first. Re-read the state so a field the scheduler just wrote wins.
  if (partial['schedule'] !== undefined) {
    const fresh = await deps.store.load(id);
    const state = fresh?.state ?? jobFile.state;
    const now = (deps.now ?? (() => new Date()))();
    await deps.store.saveState(id, {
      ...state,
      next_due_at: nextDue(result.data.schedule, now).getTime(),
    });
  } else if (partial['enabled'] === true && !jobFile.job.enabled) {
    // A resume by update: same stale-slot rule as the resume action.
    await deps.store.setEnabled(
      { ...jobFile, job: result.data },
      true,
      (deps.now ?? (() => new Date()))(),
    );
  }
  return `Updated job "${result.data.name}" [${id}]${describeUpdatedFields(result.data, partial)}.`;
}

function assertWakeSupported(wake: boolean, platform: NodeJS.Platform): void {
  if (wake && platform !== 'win32') {
    throw new Error('manage_jobs: wake is Windows-only; omit it on this platform.');
  }
}

/** Pause or resume a job (sets `enabled`). */
async function setEnabled(
  deps: ManageJobsDeps,
  jobFile: JobFile,
  enabled: boolean,
): Promise<string> {
  // The job is already a validated `Job`; flipping `enabled` cannot make it invalid.
  await deps.store.setEnabled(jobFile, enabled, (deps.now ?? (() => new Date()))());
  return `${enabled ? 'Resumed' : 'Paused'} job "${jobFile.job.name}" [${jobFile.job.id}].`;
}

/** Open (or reuse) the job's discuss chat; a new one is seeded (B.6). */
async function discussJob(deps: ManageJobsDeps, jobFile: JobFile): Promise<string> {
  const host = deps.hostFacade?.();
  if (!host)
    throw new Error('manage_jobs: `discuss` is not available in this window (no host facade).');
  // The tool runs where the user is, so the chat is activated; the phone entry point is not.
  const { created } = await openDiscussChat(host, deps.store, jobFile, true);
  return appendHomeNote(
    created
      ? `Opened the discuss chat for "${jobFile.job.name}" [${jobFile.job.id}] and seeded it with the job, its recent runs, and the last observation. It is now an ordinary chat where manage_jobs is available.`
      : `Opened the existing discuss chat for "${jobFile.job.name}" [${jobFile.job.id}]; nothing was sent to it. It is an ordinary chat where manage_jobs is available.`,
    deps.getConfig(),
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
}
