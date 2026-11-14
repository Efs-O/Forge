import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { terminateCliProcessTree } from '../agents/cliProcess';
import { protectProcessTree } from '../util/windowsJobKeeper';
import { assertSpawnCwd, normalizeSpawnCwd } from '../util/processSpawn';
import { getLogger } from '../util/logger';
import { backgroundRegistry, type BackgroundRegistry } from './backgroundRegistry';
import { readOutput, retainOutput, tailLines } from './backgroundOutput';

const MAX_BACKGROUND_EXECUTIONS = 32;
const FINISHED_EXECUTION_TTL_MS = 10 * 60 * 1000;

export type {
  BackgroundExecution,
  BackgroundExecutionStatus,
  BackgroundExecutionSummary,
  BackgroundExecutionStart,
  BackgroundExecutionObservation,
  BackgroundExecutionStartOptions,
  BackgroundExecutionCompletion,
  BackgroundExecutionExitNotice,
} from './backgroundExecutionTypes';
import type {
  BackgroundExecution,
  BackgroundExecutionCompletion,
  BackgroundExecutionExitNotice,
  BackgroundExecutionObservation,
  BackgroundExecutionStart,
  BackgroundExecutionStartOptions,
  BackgroundExecutionSummary,
  BackgroundExecutionStatus,
} from './backgroundExecutionTypes';

export class BackgroundExecutionManager {
  private readonly executions = new Map<string, BackgroundExecution>();
  private exitListener: ((notice: BackgroundExecutionExitNotice) => void) | undefined;
  private disposing: Promise<void> | undefined;

  constructor(private readonly registry: BackgroundRegistry = backgroundRegistry) {}

  onNotifiedExit(listener: (notice: BackgroundExecutionExitNotice) => void): { dispose(): void } {
    this.exitListener = listener;
    return {
      dispose: () => {
        if (this.exitListener === listener) this.exitListener = undefined;
      },
    };
  }

  start(options: BackgroundExecutionStartOptions): BackgroundExecutionStart {
    this.pruneFinished();
    if (this.executions.size >= MAX_BACKGROUND_EXECUTIONS) {
      this.removeOldestFinished();
    }
    if (this.executions.size >= MAX_BACKGROUND_EXECUTIONS) {
      throw new Error(
        `background execution limit reached (${MAX_BACKGROUND_EXECUTIONS}); stop or wait for an existing execution first`,
      );
    }

    const cwd = normalizeSpawnCwd(options.cwd);
    assertSpawnCwd(cwd, options.command);
    const process = spawn(options.command, [...options.args], {
      shell: false,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(globalThis.process.platform !== 'win32' ? { detached: true } : {}),
      windowsHide: true,
      // The user env is spread before NO_COLOR/FORCE_COLOR so those still win
      // over a caller-supplied value, matching the foreground path.
      env: { ...globalThis.process.env, ...options.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    // The reported defect this answers: `stop_execution` on a background bash
    // command killed the recorded pid and reported success, while the command's
    // own child kept running. The job object is what makes "stopped" mean gone.
    protectProcessTree(process);
    const execution: BackgroundExecution = {
      id: `exec-${randomUUID()}`,
      command: options.command,
      args: [...options.args],
      cwd,
      pid: process.pid ?? undefined,
      startedAt: Date.now(),
      process,
      stdout: '',
      stderr: '',
      stdoutBase: 0,
      stderrBase: 0,
      status: 'running',
      exitCode: null,
      error: undefined,
      finishedAt: undefined,
      stopRequested: false,
      timeoutMs: options.timeoutMs,
      timeoutTimer: undefined,
      waiters: new Set(),
      notifyConversationId: options.notifyConversationId,
      exitSummary: options.exitSummary,
      // shellTool already passes the chat id in the child environment for every
      // background command, including jobs without notify_on_exit.
      conversationId: options.env?.FORGE_CONVERSATION_ID ?? options.notifyConversationId,
      outputOptions: options.outputOptions,
      terminalObserved: false,
    };
    this.executions.set(execution.id, execution);

    if (options.timeoutMs !== undefined) {
      execution.timeoutTimer = setTimeout(() => {
        if (execution.status !== 'running') return;
        execution.stopRequested = true;
        execution.error = `execution timed out after ${String(options.timeoutMs)}ms`;
        void terminateCliProcessTree(execution.process);
      }, options.timeoutMs);
    }

    process.stdout.on('data', (chunk: Buffer) => {
      execution.stdout = retainOutput(execution.stdout, chunk.toString(), (base) => {
        execution.stdoutBase += base;
      });
    });
    process.stderr.on('data', (chunk: Buffer) => {
      execution.stderr = retainOutput(execution.stderr, chunk.toString(), (base) => {
        execution.stderrBase += base;
      });
    });
    process.once('error', (error: Error) => {
      if (execution.status !== 'running') return;
      execution.error = error.message;
      this.finish(execution, execution.stopRequested ? 'terminated' : 'failed', null);
    });
    process.once('close', (code) => {
      if (execution.status !== 'running') return;
      this.finish(
        execution,
        execution.stopRequested ? 'terminated' : code === 0 ? 'completed' : 'failed',
        code,
      );
    });

    if (execution.pid !== undefined) {
      void this.registry.register(
        {
          id: execution.id,
          pid: execution.pid,
          command: execution.command,
          args: [...execution.args],
        },
        () => execution.status === 'running' && !execution.stopRequested,
      );
    } else {
      getLogger().error(
        `[BackgroundExecutionManager] ${execution.id} has no PID; it will not be reaped if the extension host is killed.`,
      );
    }

    return {
      id: execution.id,
      status: execution.status,
      pid: execution.pid,
      startedAt: execution.startedAt,
    };
  }

  async observe(
    id: string,
    waitMs: number,
    stdoutCursor: number,
    stderrCursor: number,
    signal?: AbortSignal,
  ): Promise<BackgroundExecutionObservation> {
    const execution = this.get(id);
    if (execution.status === 'running' && waitMs > 0) {
      await this.waitForChange(execution, waitMs, signal);
    }
    const observation = this.snapshot(execution, stdoutCursor, stderrCursor);
    if (observation.status !== 'running') execution.terminalObserved = true;
    return observation;
  }

  /**
   * Every execution this session still knows about. The agent's own record of
   * an execution_id does not survive a /compact, so without this a running job
   * can become permanently unreachable and unstoppable.
   */
  list(): BackgroundExecutionSummary[] {
    this.pruneFinished();
    return [...this.executions.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((execution) => ({
        id: execution.id,
        command: execution.command,
        args: execution.args,
        cwd: execution.cwd,
        ...(execution.conversationId !== undefined
          ? { conversationId: execution.conversationId }
          : {}),
        status: execution.status,
        pid: execution.pid,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        exitCode: execution.exitCode,
      }));
  }

  /** Running executions started by one chat, for its final turn notice. */
  listRunningForConversation(conversationId: string): BackgroundExecutionSummary[] {
    return this.list().filter(
      (summary) =>
        summary.status === 'running' &&
        this.executions.get(summary.id)?.conversationId === conversationId,
    );
  }

  /**
   * Silence the exit wake for every still-running execution of one chat, called
   * when that turn ends cancelled: the owner stopped it, so a job finishing
   * later must not start a turn there. The job itself keeps running —
   * list_executions, monitor_execution and stop_execution still see it, its
   * output is still collected, and the end-of-turn notice still lists it,
   * because that reads `conversationId`, not this flag. Executions that have
   * already finished are left alone: their notice was decided in `finish()`,
   * and one that reached the inbox before the Stop takes the existing
   * undelivered-tell path.
   */
  disarmNotify(conversationId: string): void {
    for (const execution of this.executions.values()) {
      if (execution.status === 'running' && execution.conversationId === conversationId)
        execution.notifyConversationId = undefined;
    }
  }

  /**
   * Resolve when this execution reaches a terminal state, WITHOUT marking its
   * exit notice seen — `observe` does, which would silence the wake the caller
   * started the job for. The media tools hang the GPU lease release on this, so
   * every exit path (clean, non-zero, child error, `stop`, a timeout kill) has
   * to resolve it, and an abort resolves it too rather than hanging the lease.
   */
  async waitFinished(id: string, signal?: AbortSignal): Promise<BackgroundExecutionCompletion> {
    const execution = this.get(id);
    if (execution.status !== 'running') return this.completion(execution);
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('background execution wait aborted'));
        return;
      }
      const awake = (): void => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = (): void => {
        execution.waiters.delete(awake);
        reject(new Error('background execution wait aborted'));
      };
      // A waiter is cleared by `finish()` for every terminal path, including a
      // child that never started (`process.on('error')`) and a `stop()`.
      execution.waiters.add(awake);
      signal?.addEventListener('abort', abort, { once: true });
    });
    return this.completion(execution);
  }

  private completion(execution: BackgroundExecution): BackgroundExecutionCompletion {
    return {
      id: execution.id,
      status: execution.status,
      exitCode: execution.exitCode,
      error: execution.error,
      pid: execution.pid,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
    };
  }

  async stop(id: string): Promise<BackgroundExecutionObservation> {
    const execution = this.get(id);
    execution.terminalObserved = true;
    if (execution.status === 'running') {
      execution.stopRequested = true;
      await terminateCliProcessTree(execution.process);
      if (execution.status === 'running') this.finish(execution, 'terminated', null);
    }
    return this.snapshot(execution, execution.stdoutBase, execution.stderrBase);
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    const disposing = this.disposeRunning().finally(() => {
      this.disposing = undefined;
    });
    this.disposing = disposing;
    return disposing;
  }

  private async disposeRunning(): Promise<void> {
    const terminations: Promise<void>[] = [];
    for (const execution of this.executions.values()) {
      execution.terminalObserved = true;
      if (execution.timeoutTimer) {
        clearTimeout(execution.timeoutTimer);
        execution.timeoutTimer = undefined;
      }
      if (execution.status === 'running') {
        execution.stopRequested = true;
        terminations.push(terminateCliProcessTree(execution.process));
      }
    }
    // All trees are signalled concurrently; the host has a fixed shutdown budget.
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(terminations),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 5_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    this.executions.clear();
  }

  private get(id: string): BackgroundExecution {
    const execution = this.executions.get(id);
    if (!execution)
      // A bare "unknown execution id" named nothing the agent could act on, so the
      // refusal says how an id dies and which tool lists the ids that do exist.
      throw new Error(
        `unknown execution id "${id}". Call \`list_executions\` for the jobs retained in this window, including jobs from its other chats. A finished job is retained for up to 10 minutes; it may be evicted earlier when the 32-job limit is reached. Reloading the window clears this in-memory list. Jobs from another window are not listed here.`,
      );
    return execution;
  }

  private waitForChange(
    execution: BackgroundExecution,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        execution.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      execution.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted || execution.status !== 'running') finish();
    });
  }

  private finish(
    execution: BackgroundExecution,
    status: BackgroundExecutionStatus,
    exitCode: number | null,
  ): void {
    if (execution.timeoutTimer) {
      clearTimeout(execution.timeoutTimer);
      execution.timeoutTimer = undefined;
    }
    execution.status = status;
    execution.exitCode = exitCode;
    execution.finishedAt = Date.now();
    if (execution.pid !== undefined)
      this.registry.remove({ id: execution.id, ownerPid: process.pid });
    for (const waiter of execution.waiters) waiter();
    execution.waiters.clear();
    if (execution.notifyConversationId) {
      const completion: BackgroundExecutionCompletion = {
        id: execution.id,
        status,
        exitCode,
        error: execution.error,
        pid: execution.pid,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
      };
      const notice: BackgroundExecutionExitNotice = {
        id: execution.id,
        conversationId: execution.notifyConversationId,
        command: execution.command,
        args: [...execution.args],
        status,
        exitCode,
        error: execution.error,
        durationMs: execution.finishedAt - execution.startedAt,
        stdoutTail: tailLines(execution.stdout, 20, 2_000),
        stderrTail: tailLines(execution.stderr, 20, 2_000),
      };
      // Let an observe() promise awakened above return its terminal snapshot
      // first; that call marks the execution seen before delivery is decided.
      queueMicrotask(() => {
        if (execution.terminalObserved) return;
        if (!execution.exitSummary) {
          this.exitListener?.(notice);
          return;
        }
        // The summary is read at exit, so a manifest the child wrote last is
        // on disk by then. A hook that throws or says nothing must not cost
        // the wake: the plain notice still goes out.
        let produced: string | Promise<string> | undefined;
        try {
          produced = execution.exitSummary(completion);
        } catch {
          this.exitListener?.(notice);
          return;
        }
        void Promise.resolve(produced).then(
          (summary) => {
            if (execution.terminalObserved) return;
            this.exitListener?.(
              typeof summary === 'string' && summary.trim() ? { ...notice, summary } : notice,
            );
          },
          () => {
            if (!execution.terminalObserved) this.exitListener?.(notice);
          },
        );
      });
    }
  }

  private snapshot(
    execution: BackgroundExecution,
    stdoutCursor: number,
    stderrCursor: number,
  ): BackgroundExecutionObservation {
    const stdout = readOutput(execution.stdout, execution.stdoutBase, stdoutCursor);
    const stderr = readOutput(execution.stderr, execution.stderrBase, stderrCursor);
    return {
      id: execution.id,
      command: execution.command,
      status: execution.status,
      pid: execution.pid,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      exitCode: execution.exitCode,
      error: execution.error,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutStart: stdout.start,
      stderrStart: stderr.start,
      stdoutEnd: execution.stdoutBase + execution.stdout.length,
      stderrEnd: execution.stderrBase + execution.stderr.length,
      stdoutOldest: execution.stdoutBase,
      stderrOldest: execution.stderrBase,
      stdoutDropped: stdout.dropped,
      stderrDropped: stderr.dropped,
      outputOptions: execution.outputOptions,
    };
  }

  private pruneFinished(): void {
    for (const [id, execution] of this.executions) {
      if (
        execution.status !== 'running' &&
        execution.finishedAt !== undefined &&
        Date.now() - execution.finishedAt >= FINISHED_EXECUTION_TTL_MS
      ) {
        this.executions.delete(id);
      }
    }
  }

  private removeOldestFinished(): void {
    let oldest: BackgroundExecution | undefined;
    for (const execution of this.executions.values()) {
      if (
        execution.status !== 'running' &&
        execution.finishedAt !== undefined &&
        (oldest?.finishedAt === undefined || execution.finishedAt < oldest.finishedAt)
      ) {
        oldest = execution;
      }
    }
    if (oldest) this.executions.delete(oldest.id);
  }
}

export const backgroundExecutionManager = new BackgroundExecutionManager();
