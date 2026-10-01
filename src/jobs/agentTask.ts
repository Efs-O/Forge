import * as fs from 'fs';
import type { JobStore } from './JobStore';
import { startTaskRunHeartbeat, snapshotConfig } from './agentTaskState';
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
import type { Action, JobFile, RunRow } from './jobSchema';
import type { ModelConfig, GpuGateConfig } from '../config/types';
import type { GpuInfo } from '../system/systemProbes';
import { gpuGateReason } from './gpuIdleGate';
import { buildAgentTaskPrompt } from './agentTaskPrompt';
import {
  canStartNow,
  CLEAR_PENDING,
  deferBusyTask,
  USER_QUIET_MS,
  userQuietGate,
} from './agentTaskAdmission';
import { sendWithCap, sleepWithAbort } from './agentTaskCap';
import { outcomeOf, reportMessage, type AgentTaskOutcome } from './agentTaskReport';
export { parseResult } from './agentTaskPrompt';
export { canStartNow, schedulePeriodMs } from './agentTaskAdmission';
export type { AgentTaskOutcome } from './agentTaskReport';

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
  /** Model and optional probe config used only for local-GPU admission. */
  gpuGate?: {
    config: () => GpuGateConfig | undefined;
    model: (name: string) => ModelConfig | undefined;
    loadedModels: () => readonly ModelConfig[];
    signal?: () => AbortSignal;
    probe?: (signal?: AbortSignal) => Promise<GpuInfo[]>;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
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
    if (blocked) {
      // Wait for the next scheduled time: without it the job stays due (or
      // pending) and every 30 s tick re-runs the check and logs another skip.
      this.deps.store.patchState(job.id, {
        ...CLEAR_PENDING,
        next_due_at: nextDue(job.schedule, new Date(startedAt)).getTime(),
      });
      return this.deps.store.appendRun(job.id, blocked);
    }
    const status = host.status();
    const gpu = this.deps.gpuGate;
    const admissionReason = await gpuGateReason(
      {
        jobsRoot: this.deps.store.root,
        model: gpu?.model(jobModel),
        gpuGate: gpu?.config(),
        loadedModels: gpu?.loadedModels ?? (() => []),
        now: this.deps.now,
        ...(gpu?.signal ? { signal: gpu.signal() } : {}),
        ...(gpu?.probe ? { probe: gpu.probe } : {}),
        ...(gpu?.wait ? { wait: gpu.wait } : {}),
      },
      async () => {
        const slot = canStartNow(
          jobModel,
          state.conversation_id,
          pool,
          status.streamingConversationIds,
        );
        // Only a recent conversation can hold the job back; read which ones are
        // the jobs' own (they must not) only when there is one.
        const recent = status.conversations.filter((c) => startedAt - c.updatedAt < USER_QUIET_MS);
        const quiet =
          recent.length === 0
            ? undefined
            : userQuietGate(
                recent,
                new Set(
                  (await this.deps.store.loadAll()).flatMap((jf) => jf.state.conversation_id ?? []),
                ),
                startedAt,
              );
        return !slot.start ? slot.reason : quiet;
      },
    );
    if (admissionReason !== undefined) {
      await deferBusyTask(this.deps.store, jobFile, startedAt, wasLate, admissionReason);
      return;
    }
    // A previously-pending task that can now start: clear the pending flag.
    this.deps.store.patchState(job.id, CLEAR_PENDING);

    this.deps.store.patchState(job.id, {
      task_run: { started_at: startedAt, conversation_id: null, heartbeat_at: startedAt },
    });

    let conversationId: string | null = null;
    const stopHeartbeat = startTaskRunHeartbeat(
      this.deps.store,
      job.id,
      startedAt,
      () => conversationId,
      this.deps.now,
    );
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
        task_run: {
          started_at: startedAt,
          conversation_id: conversationId,
          heartbeat_at: this.deps.now(),
        },
      });
      if (jobModel) await host.setConversationModel(conversationId, jobModel);

      // Step 4: mark unattended, hold awake, and snapshot config.yaml.
      marker = unattendedConversations.mark(conversationId, { jobId: job.id, jobName: job.name });
      hold = this.deps.power.holdAwake(`agent task ${job.id}`);
      backupPath = await snapshotConfig(this.deps.store, this.deps.configPath, job.id);

      // Steps 5+6: send the prompt with the optional max_minutes cap.
      const prompt = await buildAgentTaskPrompt(this.deps.store, jobFile, action);
      const capMs = action.max_minutes !== undefined ? action.max_minutes * 60_000 : undefined;
      const sleep = this.deps.sleep ?? sleepWithAbort;
      const { result, timedOut } = await sendWithCap(host, conversationId, prompt, capMs, sleep);
      outcome = outcomeOf(result, timedOut);
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
      stopHeartbeat();
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
      const message = reportMessage(outcome, startedAt, durationMs, conversationId);
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
      ...CLEAR_PENDING,
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
}
