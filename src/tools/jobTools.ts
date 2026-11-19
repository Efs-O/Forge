/**
 * `manage_jobs` is the single persistent-job tool (B2, D4), one action per
 * call. It is advertised in every conversation when `jobs.enabled`, with read
 * for `list`/`get`, write for changes, and dangerous delete (Clanker approves it
 * only in an attended chat). `run_now` marks the next tick; `discuss` opens and
 * seeds the job chat (B.6).
 */

import * as path from 'path';
import type { ForgeConfig } from '../config/types';
import type { JobStore } from '../jobs/JobStore';
import { JOB_SCHEDULE_KINDS } from '../jobs/jobSchema';
import { jobSlug } from '../jobs/jobId';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { CLI_AGENT_CONSENT_DETAIL, needsCliConsent } from '../jobs/cliAgentGate';
import { JOB_DELETE_KEY } from '../sidebar/approvalKeyGrammar';
import { jobDefaultModel } from '../config/jobsSchema';
import type { RegisteredTool } from './ToolRegistry';
import { ACTIONS, runManageJobs, type Action } from './jobToolActions';

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
                'The job id, exactly as `list` shows it. Required for every action except `list` ' +
                'and `create`; `get` also accepts the name or a unique part of it. Never the job ' +
                'definition: that goes in `definition`.',
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
    mutation: {
      paths: (args) => {
        const action = args['action'];
        const mutates = action === DELETE_ACTION || WRITE_ACTIONS.has(action as Action);
        if (!mutates) return []; // Undo copies the files the action writes or removes
        if (action === 'create') {
          const definition = args['definition'];
          const name =
            definition !== null && typeof definition === 'object' && !Array.isArray(definition)
              ? (definition as Record<string, unknown>)['name']
              : undefined;
          if (typeof name !== 'string' || !name.trim()) return [];
          const slug = jobSlug(name); // a collision may add a suffix; both files stay here
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
          ...(action === DELETE_ACTION ? [path.join(deps.store.root, 'runs', `${id}.jsonl`)] : []),
        ];
      },
      showDiff: false, // job files live outside the workspace, so there is no editor diff
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
        const exact = (await deps.store.loadAll()).find((jf) => jf.job.id === ref);
        if (exact) {
          const { id, name } = exact.job;
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
