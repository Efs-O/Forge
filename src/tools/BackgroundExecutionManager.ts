import { randomUUID } from 'crypto';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { terminateCliProcessTree } from '../agents/cliProcess';
import { normalizeSpawnCwd } from '../util/processSpawn';

export const MAX_BACKGROUND_OUTPUT_CHARS = 200_000;
export const MAX_BACKGROUND_EXECUTIONS = 32;
const FINISHED_EXECUTION_TTL_MS = 10 * 60 * 1000;

export type BackgroundExecutionStatus = 'running' | 'completed' | 'failed' | 'terminated';

interface BackgroundExecution {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  stdoutBase: number;
  stderrBase: number;
  status: BackgroundExecutionStatus;
  exitCode: number | null;
  error: string | undefined;
  finishedAt: number | undefined;
  stopRequested: boolean;
  timeoutMs: number | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  readonly waiters: Set<() => void>;
}

export interface BackgroundExecutionSummary {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  status: BackgroundExecutionStatus;
  pid: number | undefined;
  startedAt: number;
  finishedAt: number | undefined;
  exitCode: number | null;
}

export interface BackgroundExecutionStart {
  id: string;
  status: BackgroundExecutionStatus;
  pid: number | undefined;
  startedAt: number;
}

export interface BackgroundExecutionObservation {
  id: string;
  command: string;
  status: BackgroundExecutionStatus;
  pid: number | undefined;
  startedAt: number;
  finishedAt: number | undefined;
  exitCode: number | null;
  error: string | undefined;
  stdout: string;
  stderr: string;
  /**
   * Absolute position of the first returned character. The caller caps how much
   * of `stdout` it actually shows, so only it can say where the next read
   * resumes — reporting `stdoutEnd` as the next cursor skipped everything the
   * cap held back and made truncated output unreachable.
   */
  stdoutStart: number;
  stderrStart: number;
  /** Absolute position one past the last character produced so far. */
  stdoutEnd: number;
  stderrEnd: number;
  /** Oldest position still held; anything before it was dropped by the cap. */
  stdoutOldest: number;
  stderrOldest: number;
  /** Characters between the caller's cursor and the window — lost for good. */
  stdoutDropped: number;
  stderrDropped: number;
}

export interface BackgroundExecutionStartOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /**
   * Kill deadline in ms. Undefined means the job runs until it exits, is
   * stopped, or the extension shuts down — a background job is long by
   * definition, so there is deliberately no default deadline here.
   */
  timeoutMs?: number | undefined;
}

export class BackgroundExecutionManager {
  private readonly executions = new Map<string, BackgroundExecution>();

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
    const process = spawn(options.command, [...options.args], {
      shell: false,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...globalThis.process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
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
    return this.snapshot(execution, stdoutCursor, stderrCursor);
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
        status: execution.status,
        pid: execution.pid,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        exitCode: execution.exitCode,
      }));
  }

  async stop(id: string): Promise<BackgroundExecutionObservation> {
    const execution = this.get(id);
    if (execution.status === 'running') {
      execution.stopRequested = true;
      await terminateCliProcessTree(execution.process);
      if (execution.status === 'running') this.finish(execution, 'terminated', null);
    }
    return this.snapshot(execution, execution.stdoutBase, execution.stderrBase);
  }

  dispose(): void {
    for (const execution of this.executions.values()) {
      if (execution.timeoutTimer) {
        clearTimeout(execution.timeoutTimer);
        execution.timeoutTimer = undefined;
      }
      if (execution.status === 'running') {
        execution.stopRequested = true;
        void terminateCliProcessTree(execution.process);
      }
    }
    this.executions.clear();
  }

  private get(id: string): BackgroundExecution {
    const execution = this.executions.get(id);
    if (!execution) throw new Error(`unknown execution id "${id}"`);
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
    for (const waiter of execution.waiters) waiter();
    execution.waiters.clear();
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

function retainOutput(current: string, chunk: string, onTrim: (base: number) => void): string {
  const combined = current + chunk;
  if (combined.length <= MAX_BACKGROUND_OUTPUT_CHARS) return combined;
  const trim = combined.length - MAX_BACKGROUND_OUTPUT_CHARS;
  onTrim(trim);
  return combined.slice(trim);
}

function readOutput(
  output: string,
  base: number,
  cursor: number,
): { text: string; start: number; dropped: number } {
  const safeCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  // A cursor behind the retained window resumes at the window, not at the
  // cursor — the characters in between are gone for good, and `dropped` counts
  // exactly how many the caller lost.
  const start = Math.max(safeCursor, base);
  return { text: output.slice(start - base), start, dropped: Math.max(0, base - safeCursor) };
}

export const backgroundExecutionManager = new BackgroundExecutionManager();
