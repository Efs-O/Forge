import * as fs from 'fs';
import * as path from 'path';
import type { JobStore } from './JobStore';
import { writeOutboxItem } from './JobOutbox';
import type { PowerControl } from '../system/PowerControl';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { IBackendPool } from '../backend/poolTypes';
import { unattendedConversations } from '../sidebar/unattendedConversations';
import { JobDelivery } from './JobDelivery';
import { nextDue } from './schedule';
import { resolveJobConversation } from './jobDiscuss';
import { BACKOFF_THRESHOLD, MAX_BACKOFF_MS } from './backoff';
import type { Action, JobFile, RunRow, Schedule } from './jobSchema';

/** The `agent_task` action, narrowed from the discriminated union. */
export type AgentTaskAction = Extract<Action, { kind: 'agent_task' }>;

/**
 * The agent-task runner (phase 3): runs an agent turn in the job's own
 * conversation, unattended, and reports the outcome through the outbox.
 * Started from `JobScheduler.runJob` and not awaited by the tick (AC11); the
 * runner writes its own run row and disposes its marker and hold in `finally`.
 * Step 7 (restart + rollback) is phase 4; this snapshots the config backup
 * (step 4) and parses `RESTART:` (step 8) but does not restart yet.
 */

export interface AgentTaskDeps {
  store: JobStore;
  power: PowerControl;
  host: () => ForgeHostFacade | undefined;
  pool: () => IBackendPool | undefined;
  /** The default chat model (config active_model), when the action names none. */
  defaultModel: () => string | undefined;
  outboxDir: string;
  notifyLocal: (text: string) => void;
  busy: () => string | undefined;
  now: () => number;
  /** The config.yaml path to snapshot before the turn (rollback for step 7). */
  configPath?: string;
  /** Injectable clock timer for the `max_minutes` cap. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** The parsed outcome of an agent turn's final message. */
export interface AgentTaskOutcome {
  /** ok | no_change | failed | timeout. */
  kind: 'ok' | 'no_change' | 'failed' | 'timeout';
  /** The RESULT sentence (after the `RESULT:` line), or a fallback. */
  sentence: string;
  /** Whether the final message asked for a backend restart. */
  restart: boolean;
  /** The final assistant text of the turn. */
  finalText: string;
}

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
  const loaded = pool.loadedModelNames();
  const resident = loaded.length === 1 ? loaded[0] : undefined;
  const streaming = streamingConversationIds.length;

  // Hard wait: its own chat is busy (two turns in one conversation interleave).
  if (ownConversationId !== null && streamingConversationIds.includes(ownConversationId)) {
    return { start: false, reason: 'its own conversation is streaming' };
  }
  // Hard wait: a different model is streaming (a 2nd server spills VRAM).
  if (resident !== undefined && resident !== jobModel && streaming > 0) {
    return { start: false, reason: `a different model (${resident}) is streaming` };
  }
  // Its model is usable: resident, nothing loaded, or a different resident with nothing streaming.
  const modelUsable =
    loaded.length === 0 || resident === jobModel || (resident !== jobModel && streaming === 0);
  if (!modelUsable) return { start: false, reason: `its model (${jobModel}) is not resident` };
  const capacity = pool.parallelCapacity(jobModel);
  if (streaming >= capacity) {
    return { start: false, reason: `all ${capacity} parallel slot(s) are streaming` };
  }
  return { start: true, reason: '' };
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

export class AgentTaskRunner {
  private readonly deps: AgentTaskDeps;
  private readonly delivery: JobDelivery;

  constructor(deps: AgentTaskDeps) {
    this.deps = deps;
    this.delivery = new JobDelivery({
      store: deps.store,
      outboxDir: deps.outboxDir,
      notifyLocal: deps.notifyLocal,
      busy: deps.busy,
      summarize: undefined,
      now: deps.now,
    });
  }

  /**
   * Run one agent task (steps 1-6, 8, 9). Never throws to the caller: every
   * failure is recorded as a `failed` run row and reported through the outbox.
   */
  async run(jobFile: JobFile, wasLate: boolean): Promise<void> {
    const { job, state } = jobFile;
    const action = job.action;
    if (action?.kind !== 'agent_task') return;

    const startedAt = this.deps.now();
    const pool = this.deps.pool();
    const host = this.deps.host();
    if (!pool || !host) {
      await this.finish(
        jobFile,
        action,
        wasLate,
        startedAt,
        {
          kind: 'failed',
          sentence: 'runner is not wired (no host facade or backend pool)',
          restart: false,
          finalText: '',
        },
        null,
        undefined,
      );
      return;
    }

    // Step 1: start now if a slot is free, otherwise wait (record pending).
    const jobModel = action.model ?? this.deps.defaultModel() ?? '';
    const slot = canStartNow(
      jobModel,
      state.conversation_id,
      pool,
      host.status().streamingConversationIds,
    );
    if (!slot.start) {
      // A pending task older than one schedule period is dropped with a
      // "skipped: busy" run row (the ledger's `task_pending` TTL): a box that
      // is always busy must not accumulate pending tasks forever.
      if (state.task_pending && state.task_pending_since !== null) {
        const period = schedulePeriodMs(job.schedule, startedAt);
        if (startedAt - state.task_pending_since >= period) {
          this.deps.store.patchState(job.id, { task_pending: false, task_pending_since: null });
          await this.deps.store.appendRun(job.id, {
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
      this.deps.store.patchState(job.id, {
        task_pending: true,
        task_pending_since: state.task_pending ? state.task_pending_since : startedAt,
      });
      return;
    }
    // A previously-pending task that can now start: clear the pending flag.
    this.deps.store.patchState(job.id, { task_pending: false, task_pending_since: null });

    // Step 2: persist the marker before anything else.
    this.deps.store.patchState(job.id, {
      task_run: { started_at: startedAt, conversation_id: null },
    });

    let conversationId: string | null = null;
    let marker: { dispose(): void } | undefined;
    let hold: { dispose(): void } | undefined;
    let backupPath: string | undefined;
    let outcome: AgentTaskOutcome = {
      kind: 'failed',
      sentence: 'unknown error',
      restart: false,
      finalText: '',
    };
    try {
      // Step 3: model. Unload a different resident model (nothing streaming),
      // then open the job's own conversation (not activated) and set its model.
      const resident =
        pool.loadedModelNames().length === 1 ? pool.loadedModelNames()[0] : undefined;
      if (
        resident &&
        resident !== jobModel &&
        host.status().streamingConversationIds.length === 0
      ) {
        await host.unloadModels();
      }
      const resolved = await resolveJobConversation(host, this.deps.store, jobFile, false);
      conversationId = resolved.conversationId;
      this.deps.store.patchState(job.id, {
        task_run: { started_at: startedAt, conversation_id: conversationId },
      });
      if (jobModel) await host.setConversationModel(conversationId, jobModel);

      // Step 4: mark unattended (carrying the job id/name), take the power
      // hold, and snapshot config.yaml for the step-7 rollback.
      marker = unattendedConversations.mark(conversationId, { jobId: job.id, jobName: job.name });
      hold = this.deps.power.holdAwake(`agent task ${job.id}`);
      backupPath = await this.snapshotConfig(job.id);

      // Steps 5+6: send the prompt and await it, with the optional max_minutes
      // cap. The cap cancels and awaits the send settling, so `finally` never
      // runs while the turn is still unwinding.
      const prompt = await this.buildPrompt(jobFile, action);
      let timedOut = false;
      const capMs = action.max_minutes !== undefined ? action.max_minutes * 60_000 : undefined;
      const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const cap =
        capMs !== undefined
          ? sleep(capMs).then(() => {
              timedOut = true;
              void host.cancel(conversationId!);
            })
          : undefined;
      let result;
      try {
        result = await host.send(conversationId, prompt);
      } finally {
        // Let the cap timer settle so it cannot fire after the turn is done.
        if (cap) await cap.catch(() => undefined);
      }
      outcome = this.outcomeOf(result, timedOut);
    } catch (err) {
      outcome = {
        kind: 'failed',
        sentence: (err as Error).message,
        restart: false,
        finalText: '',
      };
    } finally {
      // Step 9: clean up on every exit path, including abort and error.
      marker?.dispose();
      hold?.dispose();
      await this.finish(jobFile, action, wasLate, startedAt, outcome, conversationId, backupPath);
    }
  }

  /** Step 4: snapshot config.yaml's bytes to `state/<id>.config.bak`. */
  private async snapshotConfig(jobId: string): Promise<string | undefined> {
    if (!this.deps.configPath) return undefined;
    const backupPath = path.join(this.deps.store.root, 'state', `${jobId}.config.bak`);
    try {
      const bytes = await fs.promises.readFile(this.deps.configPath);
      await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.promises.writeFile(backupPath, bytes);
      return backupPath;
    } catch {
      // A missing config is not fatal to the turn; the step-7 rollback simply
      // has nothing to restore.
      return undefined;
    }
  }

  /** Step 5: build the prompt from the task, observation, last 3 runs, and the
   * unattended instructions. */
  private async buildPrompt(jobFile: JobFile, action: AgentTaskAction): Promise<string> {
    const { job, state } = jobFile;
    const runs = await this.deps.store.readRuns(job.id);
    const recent = runs.slice(-3);
    const runLines = recent.length
      ? recent.map(
          (row) => `- ${new Date(row.at).toLocaleString()}: ${row.outcome} — ${row.summary}`,
        )
      : ['(no earlier runs)'];
    const parts = [
      `Scheduled task for job "${job.name}":`,
      '',
      action.task,
      '',
      `Check observation: ${state.last_observation ?? '(none)'}`,
      '',
      `Last ${recent.length} run(s):`,
      ...runLines,
      '',
      'The facts in this message are current; where they disagree with anything ' +
        'earlier in this chat or its compaction summary, these win.',
      '',
      `You are running unattended as scheduled job "${job.name}". Nobody will answer ` +
        'questions or approvals. Dangerous actions will be denied. End your final ' +
        'message with exactly one line:',
      '`RESULT: ok | no_change | failed — <one sentence>`',
      'If you changed llama_server.binary, add a line `RESTART: yes`. Do not ' +
        'restart the backend yourself: you are running on it.',
    ];
    return parts.join('\n');
  }

  /** Step 8: map a request outcome + timeout flag to the report outcome. */
  private outcomeOf(
    result:
      | { kind: 'completed'; finalText: string }
      | { kind: 'failed'; error: string; finalText?: string }
      | { kind: 'cancelled'; finalText?: string }
      | { kind: 'interrupted'; finalText?: string },
    timedOut: boolean,
  ): AgentTaskOutcome {
    const finalText = result.finalText ?? '';
    if (timedOut)
      return {
        kind: 'timeout',
        sentence: 'timed out after the max_minutes cap',
        restart: false,
        finalText,
      };
    if (result.kind === 'failed') {
      return { kind: 'failed', sentence: result.error, restart: false, finalText };
    }
    if (result.kind === 'cancelled' || result.kind === 'interrupted') {
      return { kind: 'failed', sentence: `the turn was ${result.kind}`, restart: false, finalText };
    }
    const parsed = parseResult(finalText);
    return {
      kind: parsed.kind,
      sentence: parsed.sentence,
      restart: parsed.restart,
      finalText,
    };
  }

  /** Step 8 (report) + step 9 (cleanup): deliver, clear state, append run row. */
  private async finish(
    jobFile: JobFile,
    action: AgentTaskAction,
    wasLate: boolean,
    startedAt: number,
    outcome: AgentTaskOutcome,
    conversationId: string | null,
    backupPath: string | undefined,
  ): Promise<void> {
    const { job } = jobFile;
    const now = this.deps.now();
    const durationMs = now - startedAt;
    const failed = outcome.kind === 'failed' || outcome.kind === 'timeout';
    const report = action.report;

    // Deliver: every failure immediately; ok when `report` allows it;
    // no_change only goes to the run log.
    let delivered = 0;
    const shouldReport = failed || (outcome.kind === 'ok' && report === 'always');
    if (shouldReport) {
      const message = this.reportMessage(outcome, durationMs, conversationId);
      await this.delivery.deliver(job, message).catch(() => undefined);
      delivered = 1;
    }

    // Backoff on failure (the runner already reported it, so no extra message).
    const fresh = (await this.deps.store.load(job.id)) ?? jobFile;
    const consecutive = failed ? fresh.state.consecutive_failures + 1 : 0;
    const nextDueAt = failed
      ? (() => {
          const interval = Math.max(60_000, nextDue(job.schedule, new Date(now)).getTime() - now);
          const backoff =
            consecutive < BACKOFF_THRESHOLD
              ? 0
              : Math.min(MAX_BACKOFF_MS, interval * 2 ** (consecutive - BACKOFF_THRESHOLD + 1));
          return backoff > 0 ? now + backoff : nextDue(job.schedule, new Date(now)).getTime();
        })()
      : nextDue(job.schedule, new Date(now)).getTime();

    // Step 9: clear the state fields this runner writes (task_run, task_pending).
    this.deps.store.patchState(job.id, {
      task_run: null,
      task_pending: false,
      task_pending_since: null,
      last_run_at: now,
      ...(failed ? {} : { last_ok_at: now }),
      next_due_at: nextDueAt,
      consecutive_failures: consecutive,
    });

    // Delete the config backup on success; keep it on failure for the owner.
    if (backupPath && !failed) {
      await fs.promises.unlink(backupPath).catch(() => undefined);
    }

    const row: RunRow = {
      at: startedAt,
      late: wasLate,
      outcome: failed ? 'failed' : 'ok',
      changed: true,
      summary: outcome.sentence,
      ...(failed ? { error: outcome.sentence } : {}),
      delivered,
    };
    await this.deps.store.appendRun(job.id, row);
  }

  private reportMessage(
    outcome: AgentTaskOutcome,
    durationMs: number,
    conversationId: string | null,
  ): string {
    const tail = outcome.finalText.slice(-800);
    return (
      `${outcome.kind}: ${outcome.sentence} ` +
      `(${formatDuration(durationMs)})` +
      (conversationId ? ` — conversation ${conversationId}` : '') +
      (tail ? `\n\n${tail}` : '')
    );
  }
}

/** Parse the `RESULT:` line (and an optional `RESTART:` line) from final text. */
export function parseResult(finalText: string): {
  kind: 'ok' | 'no_change' | 'failed';
  sentence: string;
  restart: boolean;
} {
  const restart = /\bRESTART:\s*yes\b/i.test(finalText);
  const line = finalText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^RESULT:\s*/i.test(l));
  if (!line) {
    return {
      kind: 'failed',
      sentence: 'agent ended without a RESULT line',
      restart,
    };
  }
  const raw = line.replace(/^RESULT:\s*/i, '').trim();
  const [head, ...rest] = raw.split('—');
  const sentence = (rest.length ? rest.join('—') : head).trim() || head.trim();
  const lower = raw.toLowerCase();
  let kind: 'ok' | 'no_change' | 'failed';
  if (lower.startsWith('no_change')) kind = 'no_change';
  else if (lower.startsWith('ok')) kind = 'ok';
  else kind = 'failed';
  return { kind, sentence, restart };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Crash / reload recovery (CI-enforced). On `start()`, any job whose state
 * still holds a `task_run` was running when Forge died: report it through the
 * outbox, record a `failed` run row, and clear the marker. Not retried
 * automatically — the next tick runs it. Idempotent.
 */
export async function recoverInterruptedRuns(
  store: JobStore,
  outboxDir: string,
  now: () => number,
): Promise<void> {
  const jobs = await store.loadAll();
  for (const { job, state } of jobs) {
    if (!state.task_run) continue;
    const started = new Date(state.task_run.started_at);
    const hhmm = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;
    const backupPath = path.join(store.root, 'state', `${job.id}.config.bak`);
    await writeOutboxItem(
      outboxDir,
      job.id,
      job.name,
      `interrupted — Forge restarted during the run (started ${hhmm}); ` +
        `config.yaml backup kept at ${backupPath}`,
      now(),
    ).catch(() => undefined);
    await store
      .appendRun(job.id, {
        at: now(),
        late: false,
        outcome: 'failed',
        changed: false,
        summary: 'interrupted — Forge restarted during the run',
        error: 'interrupted — Forge restarted during the run',
        delivered: 1,
      })
      .catch(() => undefined);
    store.patchState(job.id, { task_run: null });
  }
}
