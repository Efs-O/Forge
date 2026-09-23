import * as fs from 'fs';
import * as path from 'path';
import type { JobStore } from './JobStore';
import { configBackupPath } from './agentTaskState';
import type { PowerControl } from '../system/PowerControl';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { IBackendPool } from '../backend/poolTypes';
import { unattendedConversations } from '../sidebar/unattendedConversations';
import { JobDelivery } from './JobDelivery';
import { nextDue } from './schedule';
import { getLogger } from '../util/logger';
import { resolveJobConversation } from './jobDiscuss';
import { nextDueWithBackoff } from './backoff';
import { restartAfterTurn } from './agentTaskRestart';
import type { Action, JobFile, RunRow, Schedule } from './jobSchema';
import { buildAgentTaskPrompt, parseResult } from './agentTaskPrompt';
export { parseResult } from './agentTaskPrompt';

/** The `agent_task` action, narrowed from the discriminated union. */
export type AgentTaskAction = Extract<Action, { kind: 'agent_task' }>;

/**
 * The agent-task runner (phase 3): runs an agent turn in the job's own
 * conversation, unattended, and reports the outcome through the outbox.
 * Started from `JobScheduler.runJob` and not awaited by the tick (AC11); the
 * runner writes its own run row and disposes its marker and hold in `finally`.
 * Durable run state (the config backup, crash recovery) is `agentTaskState.ts`.
 */

export interface AgentTaskDeps {
  store: JobStore;
  power: PowerControl;
  host: () => ForgeHostFacade | undefined;
  pool: () => IBackendPool | undefined;
  /** The default chat model (config active_model), when the action names none. */
  defaultModel: () => string | undefined;
  /** A skipped row when this model is a CLI agent jobs may not use (cliAgentGate). */
  cliAgentSkip?: (model: string, at: number, late: boolean) => RunRow | undefined;
  outboxDir: string;
  notifyLocal: (text: string) => void;
  busy: () => string | undefined;
  now: () => number;
  /** The config.yaml path to snapshot before the turn (rollback for step 7). */
  configPath?: string;
  /** Injectable abortable timer for the `max_minutes` cap. Defaults to setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  const streaming = streamingConversationIds.length;
  const others = pool.loadedModelsExcept(jobModel);

  // Hard wait: its own chat is busy (two turns in one conversation interleave).
  if (ownConversationId !== null && streamingConversationIds.includes(ownConversationId)) {
    return { start: false, reason: 'its own conversation is streaming' };
  }
  // Hard wait: another model is loaded and a chat is streaming. The job may not
  // unload it mid-turn, and loading beside it spills VRAM (2026-09-23: two
  // resident models plus a job's third server took every GPU down).
  if (others.length > 0 && streaming > 0) {
    return { start: false, reason: `another model (${others.join(', ')}) is in use` };
  }
  // Nothing else streams: step 3 unloads every other model before the turn.
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
  /** Models a job loaded (not resident at its start); released when jobs finish. */
  private readonly loadedByJobs = new Set<string>();

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

  /** Run one agent task (steps 1-6, 8, 9), recording every failure. */
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

    const jobModel = action.model ?? this.deps.defaultModel() ?? '';
    const blocked = this.deps.cliAgentSkip?.(jobModel, startedAt, wasLate);
    if (blocked) return this.deps.store.appendRun(job.id, blocked);
    const slot = canStartNow(
      jobModel,
      state.conversation_id,
      pool,
      host.status().streamingConversationIds,
    );
    if (!slot.start) {
      // Drop a pending task older than one schedule period (the task_pending TTL).
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
      // Step 3: unload every other idle model, then open this job's chat. The
      // job runs on one server; a model it had to load is released afterwards.
      if (
        pool.loadedModelsExcept(jobModel).length > 0 &&
        host.status().streamingConversationIds.length === 0
      ) {
        await host.unloadModels();
      }
      if (jobModel && !pool.isLoaded(jobModel)) this.loadedByJobs.add(jobModel);
      const resolved = await resolveJobConversation(host, this.deps.store, jobFile, false);
      conversationId = resolved.conversationId;
      this.deps.store.patchState(job.id, {
        task_run: { started_at: startedAt, conversation_id: conversationId },
      });
      if (jobModel) await host.setConversationModel(conversationId, jobModel);

      // Step 4: mark unattended, hold awake, and snapshot config.yaml.
      marker = unattendedConversations.mark(conversationId, { jobId: job.id, jobName: job.name });
      hold = this.deps.power.holdAwake(`agent task ${job.id}`);
      backupPath = await this.snapshotConfig(job.id);

      // Steps 5+6: send the prompt with the optional max_minutes cap.
      const prompt = await buildAgentTaskPrompt(this.deps.store, jobFile, action);
      let timedOut = false;
      const capMs = action.max_minutes !== undefined ? action.max_minutes * 60_000 : undefined;
      const sleep = this.deps.sleep ?? sleepWithAbort;
      const capController = capMs !== undefined ? new AbortController() : undefined;
      let capCancelled = false;
      const cap =
        capMs !== undefined
          ? sleep(capMs, capController!.signal)
              .then(async () => {
                if (capCancelled) return;
                timedOut = true;
                await host.cancel(conversationId!);
              })
              .catch(() => undefined)
          : undefined;
      let result;
      try {
        result = await host.send(conversationId, prompt);
      } finally {
        if (cap) {
          if (timedOut) {
            // Do not clear the marker or awake hold until cancellation settles.
            await cap;
          } else {
            capCancelled = true;
            capController!.abort();
          }
        }
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
      // Step 7: restart after the turn (RESTART: yes AND RESULT: ok), before the
      // report, so the report reflects the restart outcome. It runs while the
      // marker and hold are still active, so the machine stays awake through the
      // restart. Never throws: a restart failure is folded into the outcome, and
      // a bug here must not break the cleanup below.
      try {
        outcome = await restartAfterTurn(
          {
            host,
            pool,
            configPath: this.deps.configPath,
            backupPath,
            ...(this.deps.sleep !== undefined ? { sleep: this.deps.sleep } : {}),
          },
          jobModel,
          outcome,
        );
      } catch (err) {
        // A bug in step 7 must not report the pre-restart "ok": the binary's
        // state after a thrown restart is unknown.
        outcome = {
          kind: 'failed',
          sentence: `restart after the turn failed unexpectedly (${String(err)})`,
          restart: false,
          finalText: outcome.finalText,
        };
      }
      // Step 9: clean up on every exit path.
      marker?.dispose();
      hold?.dispose();
      await this.releaseJobModel(jobModel, host, pool);
      await this.finish(jobFile, action, wasLate, startedAt, outcome, conversationId, backupPath);
    }
  }

  /**
   * Release a model that a job loaded, once no conversation streams. Jobs
   * sharing it (same tick, same model) leave it for the last one out. A model
   * that was already resident when the job started is never released.
   */
  private async releaseJobModel(
    jobModel: string,
    host: ForgeHostFacade,
    pool: IBackendPool,
  ): Promise<void> {
    if (!this.loadedByJobs.has(jobModel)) return;
    if (host.status().streamingConversationIds.length > 0) return;
    this.loadedByJobs.delete(jobModel);
    if (!pool.isLoaded(jobModel)) return;
    try {
      await pool.release(jobModel);
    } catch (err) {
      // The job's result stands; a model left loaded is reported, not fatal.
      getLogger().warn(`[AgentTask] could not release ${jobModel} after the job: ${String(err)}`);
    }
  }

  /** Snapshot config.yaml's bytes to `state/<id>.config.bak`. */
  private async snapshotConfig(jobId: string): Promise<string | undefined> {
    if (!this.deps.configPath) return undefined;
    const backupPath = configBackupPath(this.deps.store, jobId);
    try {
      const bytes = await fs.promises.readFile(this.deps.configPath);
      await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.promises.writeFile(backupPath, bytes);
      return backupPath;
    } catch {
      // A missing config is not fatal; rollback simply has nothing to restore.
      return undefined;
    }
  }

  /** Build the prompt from the task, observation, last 3 runs, and instructions. */
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
    if (!(await this.deps.store.load(job.id))) return;
    const now = this.deps.now();
    const durationMs = now - startedAt;
    const failed = outcome.kind === 'failed' || outcome.kind === 'timeout';
    const report = action.report;

    // Deliver: every failure immediately and every change (`ok`) under either
    // setting; `no_change` only under `always`, else the run log alone.
    let delivered = 0;
    const shouldReport =
      failed || outcome.kind === 'ok' || (outcome.kind === 'no_change' && report === 'always');
    if (shouldReport) {
      const message = this.reportMessage(outcome, durationMs, conversationId);
      await this.delivery.deliver(job, message).catch(() => undefined);
      delivered = 1;
    }

    // Backoff on failure; the runner already reported it.
    const fresh = (await this.deps.store.load(job.id)) ?? jobFile;
    const consecutive = failed ? fresh.state.consecutive_failures + 1 : 0;
    const nextDueAt = failed
      ? nextDueWithBackoff(job.schedule, new Date(now), consecutive)
      : nextDue(job.schedule, new Date(now)).getTime();

    // Clear the state fields this runner writes.
    this.deps.store.patchState(job.id, {
      task_run: null,
      task_pending: false,
      task_pending_since: null,
      last_run_at: now,
      // Success records the observation the agent acted on, so the next check
      // compares against it; a failure keeps the old one and is retried.
      ...(failed ? {} : { last_ok_at: now, last_observation: jobFile.state.last_observation }),
      next_due_at: nextDueAt,
      consecutive_failures: consecutive,
    });

    if (backupPath && !failed) {
      await fs.promises.unlink(backupPath).catch(() => undefined);
    }

    const row: RunRow = {
      at: startedAt,
      late: wasLate,
      outcome: failed ? 'failed' : 'ok',
      changed: outcome.kind === 'ok',
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

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('timer aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('timer aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
