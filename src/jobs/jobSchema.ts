import { z } from 'zod';

/**
 * The Zod schemas for a persistent agent job (B.1): its definition, its
 * mutable run state, and a single run-log row.
 *
 * Layout (D1): `~/.forge/jobs/` — one `<id>.json` per job (the definition),
 * its state in a separate `state/<id>.json`, and an append-only
 * `runs/<id>.jsonl` run log. The state is a separate file so a user edit of the
 * definition never races a run writing state.
 *
 * Kept separate from the config schema: a job is data the user (or the
 * `manage_jobs` tool) edits, not a machine-local config knob.
 */

/** `owner/name` GitHub repository. */
const RepoSchema = z
  .string()
  .refine(
    (repo) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo),
    'use owner/name, e.g. ggml-org/llama.cpp',
  );

/** A local `HH:MM` clock time. */
const ClockTimeSchema = z
  .string()
  .refine(
    (at) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(at),
    'use HH:MM, e.g. 06:00 (24-hour clock, 00:00-23:59)',
  );

const WeekdaySchema = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
export type Weekday = z.infer<typeof WeekdaySchema>;

/**
 * The refusal a discriminated union gives for a `kind` it does not know.
 *
 * Zod reports `invalid_union` with no values at all for that ("No matching
 * discriminator"), so `manage_jobs` answered a bad schedule with
 * `schedule.kind Invalid input` and the model guessed again (lab run U3a,
 * 2026-11-09). The kinds are read from the union's own options, so a kind added
 * to a shape is listed by the refusal the moment that shape is added, and the
 * list is never typed twice.
 */
function kindUnionError(issue: unknown): string {
  const raw = issue as {
    inst?: { options?: readonly { shape?: Record<string, { value?: unknown } | undefined> }[] };
    input?: unknown;
  };
  const kinds = (raw.inst?.options ?? [])
    .map((option) => option.shape?.['kind']?.value)
    .filter((value): value is string => typeof value === 'string');
  const received = JSON.stringify(
    raw.input !== null && typeof raw.input === 'object'
      ? (raw.input as Record<string, unknown>)['kind']
      : raw.input,
  );
  return (
    `must be one of ${kinds.map((kind) => JSON.stringify(kind)).join(', ')}; ` +
    `received ${received === undefined ? '<missing>' : received}.`
  );
}

/**
 * When a job runs. Exactly one of the three:
 * - `interval`: every N minutes (>= 15 — below that a GitHub job hammers the
 *   API; the 15-minute floor is the minimum valid interval, B.10).
 * - `daily`: at a clock time each day.
 * - `weekly`: at a clock time on one or more weekdays.
 */
const ScheduleSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('interval'),
      minutes: z
        .number()
        .int()
        .refine(
          (minutes) => minutes >= 15,
          'interval must be at least 15 minutes. To wait for a reply, use `wait` ' +
            '(ends early on a new message).',
        ),
    }),
    z.object({
      kind: z.literal('daily'),
      at: ClockTimeSchema,
    }),
    z.object({
      kind: z.literal('weekly'),
      days: z
        .array(WeekdaySchema)
        .refine((days) => days.length >= 1, 'weekly needs at least one weekday'),
      at: ClockTimeSchema,
    }),
  ],
  { error: kindUnionError },
);
export type Schedule = z.infer<typeof ScheduleSchema>;

/** What a job watches. Exactly one of the five (B.2). */
export const CheckSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('github_release'),
      repo: RepoSchema,
      /** Glob on the asset file names; omit to track the release regardless. */
      asset_pattern: z.string().min(1).optional(),
      /**
       * Which release channel to watch. `latest` (the default) is the newest
       * non-prerelease release — `/releases/latest`. `prerelease` is the newest
       * prerelease — the llama.cpp nightly `bNNNN` builds, which `/releases/latest`
       * never returns (it returns a stub instead). A `llamacpp_update` job must
       * use `prerelease` or it will never see a real build.
       */
      channel: z.enum(['latest', 'prerelease']).default('latest'),
    }),
    z.object({
      kind: z.literal('github_issue'),
      repo: RepoSchema,
      issue_number: z.number().int().positive(),
    }),
    /** A Hugging Face discussion or PR thread; a new event or status change is a change. */
    z.object({
      kind: z.literal('hf_discussion'),
      repo: RepoSchema,
      repo_type: z.enum(['model', 'dataset', 'space']).default('model'),
      discussion_number: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('disk_space'),
      path: z.string().min(1),
      min_free_gb: z.number().positive(),
    }),
    /** Local, file-only daily tool usage measurement. */
    z.object({
      kind: z.literal('tool_usage'),
    }),
    /** No check: the job runs on every schedule tick. */
    z.object({
      kind: z.literal('none'),
    }),
  ],
  { error: kindUnionError },
);
export type Check = z.infer<typeof CheckSchema>;
export type GithubReleaseCheck = Extract<Check, { kind: 'github_release' }>;
export type GithubIssueCheck = Extract<Check, { kind: 'github_issue' }>;
export type HfDiscussionCheck = Extract<Check, { kind: 'hf_discussion' }>;
export type DiskSpaceCheck = Extract<Check, { kind: 'disk_space' }>;

/**
 * What a typed summarize focuses on. A fixed prompt is built from the job name,
 * the check's observation, and this focus — no free-form user prompt (B.5:
 * `update` takes a strict schema, no free-form blobs).
 */
const SummaryFocusSchema = z.enum(['release_notes', 'breaking_changes', 'cuda', 'assets']);

/**
 * What a job does when the check reports a change (B.1). Exactly one of the
 * two. `notify` just reports; `summarize` runs a no-tools model call to
 * summarize the change, only when no turn is streaming (it waits for idle).
 */
const OnChangeSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('notify') }),
    z.object({
      kind: z.literal('summarize'),
      focus: z.array(SummaryFocusSchema).min(1).max(3).default(['release_notes']),
    }),
  ],
  { error: kindUnionError },
);

/** The mutating actions (B.7). `llamacpp_update` is the fixed pipeline; `agent_task` runs an agent turn. */
export const ActionSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('llamacpp_update'),
      mode: z.enum(['prepare', 'apply']),
      /**
       * Asset filename `*`-glob, e.g. `llama-*-bin-win-cuda-*-x64.zip`.
       * A literal `{tag}` is NOT substituted — the pattern is matched as a
       * glob, so write a `*` where the tag varies.
       */
      asset_pattern: z.string().min(1),
    }),
    /**
     * An agent task: when the job fires, an agent reads the task, thinks,
     * runs commands and finishes. The task is capped at 4000 characters.
     */
    z.object({
      kind: z.literal('agent_task'),
      /** The plain-language task for the agent. Capped at 4000 characters. */
      task: z
        .string()
        .min(1)
        .refine((task) => task.length <= 4000, 'task must be at most 4000 characters'),
      /** Optional model override; default: the default chat model. */
      model: z.string().min(1).optional(),
      /** Optional wall-clock cap in minutes; omitted = no clock cap. */
      max_minutes: z.number().int().positive().optional(),
      /** When to report: "failures_and_changes" or "always". */
      report: z.enum(['failures_and_changes', 'always']).default('failures_and_changes'),
    }),
    /**
     * The daily retitle pass (`src/jobs/retitleRun.ts`): gives a name to the chats
     * still called after their first prompt. There is no tool here: the model
     * returns a name as plain text and the host validates and applies it, so a
     * run cannot touch a chat its own filter refused.
     */
    z.object({
      kind: z.literal('retitle'),
      /** Optional model override; default: the default chat model. */
      model: z.string().min(1).optional(),
      /** Chats renamed at most per run, so one job cannot rewrite the history list. */
      max_chats: z.number().int().min(1).max(200).default(20),
      /** A chat updated less than this many minutes ago is left alone. */
      min_idle_minutes: z.number().int().min(0).max(1440).default(60),
      /** Report what would be renamed and change nothing. */
      dry_run: z.boolean().default(false),
      /** Chats the job already named, named again on the owner's say-so, for a
       *  one-off pass over titles it got wrong. A name a person typed is never in
       *  reach whatever this list says, and the open, streaming, idle and job-chat
       *  rules still apply. Empty outside such a pass. */
      reassess_ids: z.array(z.string().min(1)).max(50).default([]),
      report: z.enum(['failures_and_changes', 'always']).default('failures_and_changes'),
    }),
  ],
  { error: kindUnionError },
);
export type Action = z.infer<typeof ActionSchema>;

/** A job definition. Immutable except by `manage_jobs` create/update. */
export const JobSchema = z.object({
  /** Schema version, for forward compatibility. */
  version: z.literal(1),
  /** Stable id, also the file name. Generated on create; never edited. */
  id: z
    .string()
    .refine((id) => /^[A-Za-z0-9._-]+$/.test(id), 'use letters, digits, dot, underscore or dash'),
  /** What the user calls it. */
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Whether the job may wake the machine from sleep to run (daily/weekly only). */
  wake: z.boolean().default(false),
  /** D6: suspend again after the wake if nothing happened. */
  after: z.enum(['stay_awake', 'sleep_if_idle']).default('stay_awake'),
  schedule: ScheduleSchema,
  check: CheckSchema,
  on_change: OnChangeSchema,
  /** The mutating action, if any. Null for a watch-only job. */
  action: z.union([z.literal(null), ActionSchema]).default(null),
  created_at: z.number().int().nonnegative().default(0),
  updated_at: z.number().int().nonnegative().default(0),
});
export type Job = z.infer<typeof JobSchema>;

/**
 * A job's mutable run state. Written by the scheduler after each run. Lives in
 * its own `state/<id>.json` file so a definition edit never races a run.
 */
export const JobStateSchema = z.object({
  /** Epoch ms of the last run that started. Null if never run. */
  last_run_at: z.number().int().nonnegative().nullable().default(null),
  /** Epoch ms of the last successful run. Null if none. */
  last_ok_at: z.number().int().nonnegative().nullable().default(null),
  /** The last observation the check produced (typed per check kind, as JSON). */
  last_observation: z.string().nullable().default(null),
  /** Consecutive failures, for backoff. Reset on a success. */
  consecutive_failures: z.number().int().nonnegative().default(0),
  /** Epoch ms the job next becomes due. Null if never computed. */
  next_due_at: z.number().int().nonnegative().nullable().default(null),
  /** The discuss chat's conversation id, if one has been opened (B.4). */
  conversation_id: z.string().nullable().default(null),
  /** A change was recorded but its summarize is still waiting for idle (B.4). */
  summary_pending: z.boolean().default(false),
  /**
   * Consecutive failed attempts at the pending summary. Separate from
   * `consecutive_failures`, which counts check failures (audit A9).
   */
  summary_failures: z.number().int().nonnegative().default(0),
  /** Epoch ms before which a failed pending summary is not retried. */
  summary_retry_at: z.number().int().nonnegative().nullable().default(null),
  /**
   * A task run is in progress. Set by the agent-task runner before anything
   * else; cleared in its `finally`. Null when idle.
   */
  task_run: z
    .object({
      started_at: z.number().int().nonnegative(),
      conversation_id: z.string().nullable().default(null),
      /** Refreshed by the running window; a stale one means that window died. */
      heartbeat_at: z.number().int().nonnegative().nullable().default(null),
    })
    .nullable()
    .default(null),
  /**
   * A task run is pending (no slot free). Set by the runner when it cannot
   * start immediately; the next idle tick retries. Default false.
   */
  task_pending: z.boolean().default(false),
  /** Latest admission reason while the task is pending. */
  task_pending_reason: z.string().nullable().default(null),
  /**
   * Epoch ms the pending task first became pending, so a pending older than one
   * schedule period can be dropped with a "skipped: busy" run row. Null when
   * not pending.
   */
  task_pending_since: z.number().int().nonnegative().nullable().default(null),
  /**
   * The observation the pending task was deferred on. The retry acts on (and
   * on success saves) this one, not the stale `last_observation`, or the next
   * check would see the same change again and run the task a second time.
   */
  task_pending_observation: z.string().nullable().default(null),
});
export type JobState = z.infer<typeof JobStateSchema>;

/** One row in the append-only run log (B.1). */
export const RunRowSchema = z.object({
  /** Epoch ms the run started. */
  at: z.number().int().nonnegative(),
  /** True when the job fell due while the machine was off and ran on resume. */
  late: z.boolean().default(false),
  outcome: z.enum(['ok', 'failed', 'skipped']),
  /** Whether the check reported a change. */
  changed: z.boolean().default(false),
  /** One-line summary of what the run did. */
  summary: z.string(),
  /** Error detail when a run failed. */
  error: z.string().optional(),
  /** How many outbox items were delivered for this run. */
  delivered: z.number().int().nonnegative().default(0),
  /**
   * True on the row that closes a run the owner stopped and then finished by
   * hand in the job's chat (`resumedRun.ts`). Absent on every row the scheduler
   * writes, so old logs parse unchanged.
   */
  resumed: z.boolean().optional(),
});
export type RunRow = z.infer<typeof RunRowSchema>;

/**
 * The in-memory combination of a job's definition and its state. The two live
 * in separate files on disk (so a definition edit never races a run), but the
 * scheduler works with them together.
 */
export interface JobFile {
  job: Job;
  state: JobState;
}
