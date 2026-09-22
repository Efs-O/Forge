/**
 * `manage_jobs` — the single agent tool for persistent agent jobs (B2, D4).
 * One tool with an `action` enum instead of five: one round per call. Advertised
 * in every conversation when `jobs.enabled`, so a watch can be added, edited,
 * paused, resumed, or removed from wherever the user is talking (user
 * requirement, 2026-09-14). Permissions: `read` for `list`/`get`, `write` for
 * the mutating actions, `delete` for `delete` (always approval, even under
 * /clanker). `run_now` writes a `run_requests/<id>` marker the scheduler
 * consumes on its next tick; `discuss` opens or reuses the job's discuss chat
 * and seeds it (B.6).
 */

import * as path from 'path';
import type { ForgeConfig } from '../config/types';
import type { JobStore } from '../jobs/JobStore';
import { JobSchema, type JobFile } from '../jobs/jobSchema';
import { nextDue } from '../jobs/schedule';
import {
  describeAction,
  describeCheck,
  describeOnChange,
  describeSchedule,
  formatWhen,
  truncate,
} from '../jobs/jobDescribe';
import { openDiscussChat } from '../jobs/jobDiscuss';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { CLI_AGENT_CONSENT_DETAIL, needsCliConsent } from '../jobs/cliAgentGate';
import type { RegisteredTool } from './ToolRegistry';

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
          '`update` takes a partial definition (for example only `schedule`), so "check at 08:00 instead" ' +
          'is one call. `delete` always asks for approval. `run_now` runs the job on the next scheduler ' +
          'tick, even from a window that does not hold the lease.',
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
                '(always asks for approval); `run_now` runs it on the next tick; `discuss` opens its ' +
                'discuss chat.',
            },
            job: {
              type: 'string',
              description:
                'The job id or name, fuzzy-matched. Required for every action except `list` and ' +
                '`create`. An ambiguous match returns the candidates instead of guessing.',
            },
            definition: {
              type: 'object',
              description:
                'For `create` and `update` only: the job definition (a partial for `update`). Fields: ' +
                '`name` (string), `enabled` (bool), `wake` (bool), `after` (stay_awake|sleep_if_idle), ' +
                '`schedule` ({kind:interval,minutes} | {kind:daily,at:"HH:MM"} | {kind:weekly,days,at}), ' +
                '`check` ({kind:github_release,repo,asset_pattern?} | {kind:github_issue,repo,issue_number} ' +
                '| {kind:disk_space,path,min_free_gb} | {kind:none}), `on_change` ({kind:notify} | {kind:summarize,focus[]}), ' +
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
    // `delete` always asks, even under /clanker: `dangerous` is what keeps
    // clanker from removing a job without anyone being asked.
    approval: (args) => {
      // Dangerous so /clanker cannot consent for the user, and a job turn
      // (unattended policy) cannot consent for itself.
      if (needsCliConsent(deps.getConfig(), jobModelOf(deps, args))) {
        return { dangerous: true, detail: CLI_AGENT_CONSENT_DETAIL };
      }
      if (args['action'] !== DELETE_ACTION) return undefined;
      return {
        dangerous: true,
        detail: `Delete job "${String(args['job'] ?? '')}". Its definition, state, and run log are removed.`,
      };
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

/** The agent_task model a create/update would run on (an unset model pins active_model). */
function jobModelOf(deps: ManageJobsDeps, args: Record<string, unknown>): string | undefined {
  if (args['action'] !== 'create' && args['action'] !== 'update') return undefined;
  const def = args['definition'] as Record<string, unknown> | undefined;
  const action = def?.['action'] as Record<string, unknown> | null | undefined;
  if (action?.['kind'] !== 'agent_task') return undefined;
  const model = action['model'];
  return typeof model === 'string' ? model : (deps.getConfig().active_model ?? undefined);
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
      return `Run requested for "${match.jobFile.job.name}" (${match.jobFile.job.id}). It will run on the next scheduler tick, in whichever window holds the jobs lease.`;
    }
    case 'discuss':
      return discussJob(deps, match.jobFile);
    default:
      throw new Error(`manage_jobs: unhandled action "${action}".`);
  }
}

/** The result of fuzzy-matching a job reference. */
type JobMatch =
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: JobFile[] }
  | { kind: 'one'; jobFile: JobFile };

/** Resolve a job by exact id, exact name, or unique substring (case-insensitive). */
async function resolveJob(deps: ManageJobsDeps, ref: string): Promise<JobMatch> {
  const all = await deps.store.loadAll();
  const needle = ref.trim().toLowerCase();
  const exact = all.find(
    (jf) => jf.job.id.toLowerCase() === needle || jf.job.name.toLowerCase() === needle,
  );
  if (exact) return { kind: 'one', jobFile: exact };
  const partial = all.filter(
    (jf) => jf.job.id.toLowerCase().includes(needle) || jf.job.name.toLowerCase().includes(needle),
  );
  if (partial.length === 0) return { kind: 'none' };
  if (partial.length === 1) return { kind: 'one', jobFile: partial[0]! };
  return { kind: 'ambiguous', candidates: partial };
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
    const last = state.last_run_at === null ? 'never' : formatWhen(state.last_run_at, now);
    const outcome = lastOutcome(state);
    const next =
      state.next_due_at === null
        ? 'not scheduled'
        : job.enabled
          ? `next ${formatWhen(state.next_due_at, now)}`
          : 'paused';
    return `- ${job.name} [${job.id}] — ${status} · ${describeSchedule(job.schedule)} · last ${last} (${outcome}) · ${next}`;
  });
  return lines.join('\n');
}

/** The outcome of the most recent run, or 'no runs yet'. */
function lastOutcome(state: JobFile['state']): string {
  if (state.last_run_at === null) return 'no runs yet';
  if (state.consecutive_failures > 0) return `failing ×${state.consecutive_failures}`;
  return 'ok';
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
  const id = uniqueId(partial['name'] as string, taken);
  const nowMs = Date.now();
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
    action: pinAgentTaskModel(partial['action'] ?? null, deps.getConfig().active_model),
    created_at: nowMs,
    updated_at: nowMs,
  };
  const result = JobSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`manage_jobs: invalid job definition: ${result.error.message}`);
  }
  await deps.store.saveJob(result.data);
  const action = result.data.action;
  const runsOn =
    action?.kind === 'agent_task' && action.model ? ` Its agent runs on ${action.model}.` : '';
  return `Created job "${result.data.name}" [${id}]. It will run on the next scheduler tick when due.${runsOn}`;
}

/**
 * An agent_task created without a `model` gets the current model written in.
 * Left empty, the runner fell back to the in-memory active model, which every
 * chat-tab model switch overwrites: an unattended job ran on a paid cloud model
 * because a tab had been switched to it two minutes earlier.
 */
function pinAgentTaskModel(action: unknown, activeModel: string | null | undefined): unknown {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) return action;
  const fields = action as Record<string, unknown>;
  if (fields['kind'] !== 'agent_task' || fields['model'] !== undefined || !activeModel)
    return action;
  return { ...fields, model: activeModel };
}

/** Build a stable id from the name: a slug, suffixed if taken (so two "llama.cpp" jobs can coexist). */
function uniqueId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'job';
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
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
  merged['updated_at'] = Date.now();
  const result = JobSchema.safeParse({ ...merged, id });
  if (!result.success) {
    throw new Error(`manage_jobs: update rejected: ${result.error.message}`);
  }
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
  }
  return `Updated job "${result.data.name}" [${id}].`;
}

/** Pause or resume a job (sets `enabled`). */
async function setEnabled(
  deps: ManageJobsDeps,
  jobFile: JobFile,
  enabled: boolean,
): Promise<string> {
  // The job is already a validated `Job`; flipping `enabled` cannot make it invalid.
  await deps.store.saveJob({ ...jobFile.job, enabled, updated_at: Date.now() });
  return `${enabled ? 'Resumed' : 'Paused'} job "${jobFile.job.name}" [${jobFile.job.id}].`;
}

/** A human-readable description of a job (for `get`). */
function describeJob(jobFile: JobFile): string {
  const { job, state } = jobFile;
  const lines = [
    `Job "${job.name}" [${job.id}]`,
    `  status: ${job.enabled ? 'enabled' : 'paused'}`,
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

/** Open (or reuse) the job's discuss chat and seed it (B.6). */
async function discussJob(deps: ManageJobsDeps, jobFile: JobFile): Promise<string> {
  const host = deps.hostFacade?.();
  if (!host) {
    throw new Error('manage_jobs: `discuss` is not available in this window (no host facade).');
  }
  // The tool runs in a window where the user is present, so the chat is brought
  // to the foreground (activate: true). The Telegram entry point does not.
  await openDiscussChat(host, deps.store, jobFile, true);
  return `Opened the discuss chat for "${jobFile.job.name}" [${jobFile.job.id}] and seeded it with the job, its recent runs, and the last observation. It is now an ordinary chat where manage_jobs is available.`;
}
