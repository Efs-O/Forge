/**
 * `manage_jobs` is the single persistent-job tool (B2, D4), one action per
 * call. It is advertised in every conversation when `jobs.enabled`, with read
 * for `list`/`get`, write for changes, and dangerous delete (Clanker approves it
 * only in an attended chat). `run_now` marks the next tick; `discuss` opens and
 * seeds the job chat (B.6).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { defaultState, type JobStore } from '../jobs/JobStore';
import { JOB_SCHEDULE_KINDS, JobSchema, type JobFile } from '../jobs/jobSchema';
import { resolveJobRef, type JobMatch } from '../jobs/jobRefResolver';
import { jobSlug, uniqueJobId } from '../jobs/jobId';
import { appendHomeNote } from '../jobs/jobsHome';
import { nextDue } from '../jobs/schedule';
import { jobCreateText } from '../jobs/jobCreateText';
import { describeJob, describeSchedule, formatWhen, lastRunOutcome } from '../jobs/jobDescribe';
import { describeUpdatedFields } from '../jobs/jobDescribe';
import { openDiscussChat } from '../jobs/jobDiscuss';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { CLI_AGENT_CONSENT_DETAIL, needsCliConsent } from '../jobs/cliAgentGate';
import { JOB_DELETE_KEY } from '../sidebar/approvalKeyGrammar';
import { jobDefaultModel, pinAgentTaskModel } from '../config/jobsSchema';
import type { RegisteredTool } from './ToolRegistry';
import { describeToolIssues } from './toolErrorText';

/** The actions `manage_jobs` can perform. */
const ACTIONS = [
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
type Action = (typeof ACTIONS)[number];

export interface ManageJobsDeps {
  store: JobStore;
  getConfig: () => ForgeConfig;
  /** Host facade for `discuss`. A lazy getter (the sidebar provider is created
   * after the tool registry); undefined until wired, in which case `discuss`
   * degrades to a clear error and the other actions still work. */
  hostFacade?: () => ForgeHostFacade | undefined;
  /** Injectable for tests. */
  now?: () => Date;
  /** Writes `jobs.allow_cli_agents: true` (the user approved the consent card). */
  allowCliAgents?: () => void;
  /** Injectable platform boundary for the Windows-only `wake` option. */
  platform?: NodeJS.Platform;
}

/** The actions that mutate a job (need `write`). */
const WRITE_ACTIONS: ReadonlySet<Action> = new Set([
  'create',
  'update',
  'pause',
  'resume',
  'run_now',
  'discuss',
]);

/** `delete` is the only action that removes a job. */
const DELETE_ACTION: Action = 'delete';

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

export function makeManageJobsTool(deps: ManageJobsDeps): RegisteredTool {
  const tool: RegisteredTool = {
    // Inline literal: the tool-audit catalog extracts this statically, so it
    // must be an object literal, not a reference to a const.
    definition: {
      type: 'function',
      function: {
        name: 'manage_jobs',
        description:
          'Manage persistent agent jobs: list, inspect, create, update, pause, resume, delete, run now, ' +
          "or open a job's discuss chat. Available in every chat when jobs are enabled. " +
          'For recurring work or work that must survive a restart; for one process exit, notify_on_exit. ' +
          '`update` takes a partial definition (for example only `schedule`), so "check at 08:00 instead" ' +
          'is one call. `delete` asks first; attended Clanker approves it. `run_now` runs the job ' +
          'on the next scheduler tick, even from a window that does not hold the lease.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'list',
                'get',
                'create',
                'update',
                'pause',
                'resume',
                'delete',
                'run_now',
                'discuss',
              ],
              description:
                'What to do. `list` lists all jobs; `get` inspects one; `create` adds one; `update` ' +
                'changes one (partial definition); `pause`/`resume` toggle it; `delete` removes it ' +
                '(asks for approval); `run_now` runs it on the next tick; `discuss` opens its ' +
                'discuss chat.',
            },
            job: {
              type: 'string',
              description:
                'The job id or name, fuzzy-matched. Required for every action except `list` and ' +
                '`create`. An ambiguous match returns the candidates instead of guessing. Never the ' +
                'job definition: that goes in `definition`.',
            },
            definition: {
              type: 'object',
              description:
                'For `create` and `update` only: the job definition (a partial for `update`). `create` requires `name`, `schedule`, `check` and `on_change`; `enabled` defaults to true, `wake` to false, `after` to stay_awake and `action` to null. Fields: ' +
                '`name` (string), `enabled` (bool), `wake` (bool), `after` (stay_awake|sleep_if_idle), ' +
                '`schedule` ({kind:interval,minutes} | {kind:daily,at:"HH:MM"} | {kind:weekly,days,at}), ' +
                '`check` ({kind:github_release,repo,asset_pattern?} | {kind:github_issue,repo,issue_number} ' +
                '| {kind:hf_discussion,repo,repo_type?,discussion_number} (needs huggingface.co in jobs.allowed_hosts) ' +
                '| {kind:disk_space,path,min_free_gb} | {kind:tool_usage} (writes daily tool-usage files, never notifies) | {kind:none} (no observation, so on_change delivers nothing)), `on_change` ({kind:notify} | {kind:summarize,focus[]}), ' +
                '`action` (null | {kind:llamacpp_update,mode,asset_pattern} | {kind:agent_task,task,model?,max_minutes?,report?}).',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    // `list`/`get` need only `read`; the mutating actions add `write`, and `delete` adds `delete`.
    // Derived from the validated `action` arg, never used for advertisement.
    additionalPermissionsForArgs: (args) => {
      const action = args['action'];
      if (action === DELETE_ACTION) return ['delete'];
      if (typeof action === 'string' && WRITE_ACTIONS.has(action as Action)) return ['write'];
      return [];
    },
    // Job files live under `~/.forge/jobs/` (outside the workspace), so no editor diff.
    mutation: {
      paths: (args) => {
        const action = args['action'];
        if (typeof action !== 'string' || !WRITE_ACTIONS.has(action as Action)) return [];
        if (action === 'create') {
          const definition = args['definition'];
          const name =
            definition !== null && typeof definition === 'object' && !Array.isArray(definition)
              ? (definition as Record<string, unknown>)['name']
              : undefined;
          if (typeof name !== 'string' || !name.trim()) return [];
          // A collision may add a numeric suffix, but both files stay under these folders.
          const slug = jobSlug(name);
          return [
            path.join(deps.store.root, `${slug}.json`),
            path.join(deps.store.root, 'state', `${slug}.json`),
          ];
        }
        const id = typeof args['job'] === 'string' ? args['job'] : undefined;
        if (!id) return [];
        return [
          path.join(deps.store.root, `${id}.json`),
          path.join(deps.store.root, 'state', `${id}.json`),
        ];
      },
      showDiff: false,
    },
    // Advertised only when a `jobs:` block is present.
    advertise: () => deps.getConfig().jobs?.enabled === true,
    // Attended Clanker approves job deletion. Dangerous keeps an unattended or job
    // turn from consenting for itself unless a rule names its job-delete: key.
    approval: async (args) => {
      // The CLI-consent branch stays dangerous, so the turn cannot consent for itself.
      if (needsCliConsent(deps.getConfig(), jobModelOf(deps, args))) {
        return { dangerous: true, detail: CLI_AGENT_CONSENT_DETAIL };
      }
      if (args['action'] !== DELETE_ACTION) return undefined;
      const ref = args['job'];
      if (typeof ref === 'string' && ref.trim()) {
        const match = await resolveJob(deps, ref);
        if (match.kind === 'one') {
          const { id, name } = match.jobFile.job;
          return {
            dangerous: true,
            detail: `Delete job "${name}" (${id}). Its definition, state, and run log are removed.`,
            approvalKey: `${JOB_DELETE_KEY}${id}`,
          };
        }
      }
      return {
        dangerous: true,
        detail: `Delete job "${String(args['job'] ?? '')}". Its definition, state, and run log are removed.`,
      };
    },
    refuseBeforeApproval: (args) => {
      const action = args['action'];
      if (action === 'create' || action === 'update') {
        const definition = args['definition'];
        if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
          // "not a string" only when it is one; a missing definition is simply missing.
          const asString = typeof definition === 'string' ? ', not a string' : '';
          const job = args['job'];
          if (typeof job === 'string' && job.trim().startsWith('{')) {
            return `Error: manage_jobs: \`${action}\` needs \`definition\`, the job definition as a JSON object${asString}. The definition was sent in \`job\`, which names an existing job (id or name). Nothing ran. Resend it as \`definition\`.`;
          }
          return `Error: manage_jobs: \`${action}\` needs \`definition\`, the job definition as a JSON object${asString}. Nothing ran.`;
        }
        const schedule = (definition as Record<string, unknown>)['schedule'];
        if (schedule !== null && typeof schedule === 'object' && !Array.isArray(schedule)) {
          const kind = (schedule as Record<string, unknown>)['kind'];
          if (kind !== undefined && !JOB_SCHEDULE_KINDS.some((accepted) => accepted === kind)) {
            return (
              `Error: manage_jobs: schedule.kind must be one of ${JOB_SCHEDULE_KINDS.join(', ')} ` +
              `(received ${JSON.stringify(kind)}).`
            );
          }
        }
      }
      if (
        typeof action === 'string' &&
        ACTIONS.includes(action as Action) &&
        action !== 'list' &&
        action !== 'create' &&
        (typeof args['job'] !== 'string' || !args['job'].trim())
      ) {
        return `Error: manage_jobs: \`${String(action)}\` needs \`job\`, the id or name of an existing job (list them with {action:"list"}). Nothing ran.`;
      }
      return undefined;
    },
    handler: (args) => {
      // Reached only past the approval card above, so a CLI model here was consented to.
      if (needsCliConsent(deps.getConfig(), jobModelOf(deps, args))) {
        if (!deps.allowCliAgents) {
          throw new Error('manage_jobs: set `jobs.allow_cli_agents: true` in config.yaml first.');
        }
        deps.allowCliAgents();
      }
      return runManageJobs(deps, args);
    },
  };
  return tool;
}

/** The agent_task model a create/update would run on (an unset model takes the job default).
 *  A `jobs.default_model` naming a removed model is NOT reported here: this runs
 *  in the approval-card builder, where a throw would fail the tool call before
 *  the user sees anything. The runner reports it at the job start that actually
 *  needs the model (`AgentTaskRunner.run`), naming the field to fix. */
function jobModelOf(deps: ManageJobsDeps, args: Record<string, unknown>): string | undefined {
  if (args['action'] !== 'create' && args['action'] !== 'update') return undefined;
  const def = args['definition'] as Record<string, unknown> | undefined;
  const action = def?.['action'] as Record<string, unknown> | null | undefined;
  if (action?.['kind'] !== 'agent_task') return undefined;
  const model = action['model'];
  if (typeof model === 'string') return model;
  try {
    return jobDefaultModel(deps.getConfig());
  } catch {
    return undefined;
  }
}

async function runManageJobs(deps: ManageJobsDeps, args: Record<string, unknown>): Promise<string> {
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
  const match = await resolveJob(deps, ref);
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

/** Resolve a job by exact id, exact name, or unique substring (case-insensitive). */
async function resolveJob(deps: ManageJobsDeps, ref: string): Promise<JobMatch> {
  return resolveJobRef(await deps.store.loadAll(), ref);
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

/** Open (or reuse) the job's discuss chat and seed it (B.6). */
async function discussJob(deps: ManageJobsDeps, jobFile: JobFile): Promise<string> {
  const host = deps.hostFacade?.();
  if (!host) {
    throw new Error('manage_jobs: `discuss` is not available in this window (no host facade).');
  }
  // The tool runs in a window where the user is present, so the chat is brought
  // to the foreground (activate: true). The Telegram entry point does not.
  await openDiscussChat(host, deps.store, jobFile, true);
  return appendHomeNote(
    `Opened the discuss chat for "${jobFile.job.name}" [${jobFile.job.id}] and seeded it with the job, its recent runs, and the last observation. It is now an ordinary chat where manage_jobs is available.`,
    deps.getConfig(),
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
}
