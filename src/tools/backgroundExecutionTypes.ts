/**
 * The shapes around one background execution: what a caller starts, what an
 * observer reads back, and what a finished job says to the chat that started it.
 *
 * Split from `BackgroundExecutionManager.ts`, which sat at the repo's 500-line
 * stop before the media tools needed a wait-for-exit handle and a manifest
 * summary on the exit notice. Shapes and lifecycle bookkeeping change for
 * different reasons: a new field on a result shape must not push the manager
 * over the cap again. `BackgroundExecutionManager.ts` re-exports every name,
 * so existing imports keep working.
 */
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import type { ExecOutputOptions } from './execHelpers';

export type BackgroundExecutionStatus = 'running' | 'completed' | 'failed' | 'terminated';

export interface BackgroundExecution {
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
  /** Cleared by `disarmNotify()` when the owner stops this chat's turn; the
   *  exit notice is decided from this at `finish()`. */
  notifyConversationId: string | undefined;
  exitSummary: BackgroundExecutionStartOptions['exitSummary'];
  readonly conversationId: string | undefined;
  readonly outputOptions: ExecOutputOptions | undefined;
  terminalObserved: boolean;
}

export interface BackgroundExecutionSummary {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  conversationId?: string;
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
  /** Optional output view selected when the job started. */
  outputOptions: ExecOutputOptions | undefined;
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
  /**
   * Optional validated env for the child, merged over the inherited env. The
   * foreground path (`spawnAndWait`) already takes `extraEnv`; without this the
   * background path would silently drop a validated `env` and the foreground
   * and background shell paths would disagree.
   */
  env?: NodeJS.ProcessEnv;
  notifyConversationId?: string;
  /**
   * Output options (tail_lines and so on) given when the job started.
   * monitor_execution applies them when its own call names none: CI started with tail_lines 200
   * used to come back as its first 16,000 characters, and the agent paged twice
   * to reach the test counts at the end.
   */
  outputOptions?: ExecOutputOptions;
  /**
   * Compute the notice's `summary` from how the job ended. Called only when a
   * notice will actually be sent, so a watcher that observed the exit first
   * never pays the read. May be async: reading a manifest is a file read.
   */
  exitSummary?: (info: BackgroundExecutionCompletion) => string | Promise<string>;
}

export interface BackgroundExecutionCompletion {
  id: string;
  status: BackgroundExecutionStatus;
  exitCode: number | null;
  error: string | undefined;
  pid: number | undefined;
  startedAt: number;
  finishedAt: number | undefined;
}

export interface BackgroundExecutionExitNotice {
  id: string;
  conversationId: string;
  command: string;
  args: readonly string[];
  status: BackgroundExecutionStatus;
  exitCode: number | null;
  error: string | undefined;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  /**
   * What the job produced, computed at exit by whoever started it. The media
   * tools use it for the run's manifest summary, so the wake says what landed
   * rather than leaving the model to read the run folder; a job that started
   * nothing to summarise leaves it out entirely.
   */
  summary?: string;
}
