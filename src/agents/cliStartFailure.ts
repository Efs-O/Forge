/**
 * Start gating and failure reporting for the two warm CLI sessions.
 *
 * `spawn()` reports a program that is not there asynchronously: the `error`
 * event arrives on a later tick, by which time the session has already written
 * to the child's stdin and that write's callback has already answered `write
 * EPIPE`. Both warm sessions reported that EPIPE, which told the user a stream
 * had broken when the truth was that the program was never found — and the
 * ENOENT that explained it was computed and thrown away because the first
 * message to arrive won. So the first write is gated on the child's start
 * outcome, the start failure is recorded in a named field that failure reporting
 * prefers, and the message and the log line are built here, once, for both.
 *
 * `cliProcess.ts` owns the spawn itself — the argv, the child's environment
 * block, the one start log line — and is already 302 lines. What a failed start
 * looks like to the user and to the log is a different concern, so it lives
 * here, shared by `CliAgentSession` (claude) and `CodexAppServerSession`
 * (codex) rather than copied into either.
 */

import type { ChildProcess } from 'node:child_process';
import type { CliProcessExit } from './cliProcess';

/** The message both warm sessions report for a child that never started, built
 *  from the OS error code and message plus the executable Forge asked to run.
 *  `write EPIPE` is only what a write to a stdin with no reader looks like: it
 *  made a missing CLI look like a stream bug, while the real reason — the
 *  program was never found — was computed and thrown away. */
export function cliSpawnFailureMessage(label: string, executable: string, error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    `Couldn't start ${label}: ` +
    `${code ? `${code} (${error.message})` : error.message}. ` +
    `Executable: ${executable}`
  );
}

/** Gates a warm session's first stdin write on the child's start outcome: it
 *  resolves `undefined` once the child reports `spawn`, or the start-failure
 *  message once it reports `error`. Node emits exactly one of the two first, so
 *  a caller that attaches these listeners straight after `spawn()` cannot miss
 *  either. `onStartFailure` runs synchronously inside the error listener —
 *  before any stop handler can choose a different message — so which handler
 *  wins a race no longer decides what the user is told.
 *  Create it once, with the process, and keep it: `spawn` is reported once, so
 *  a warm session's next send must await the same promise rather than attach
 *  new listeners and wait for an event that already happened. */
export function waitForCliSpawn(
  child: ChildProcess,
  label: string,
  executable: string,
  onStartFailure: (message: string) => void,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const settle = (): void => {
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
    };
    const onSpawn = (): void => {
      settle();
      resolve(undefined);
    };
    const onError = (error: Error): void => {
      settle();
      const message = cliSpawnFailureMessage(label, executable, error);
      onStartFailure(message);
      resolve(message);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    // Neither event can already have fired — Node emits both on a later tick,
    // and the caller attaches these listeners straight after `spawn()` — but an
    // exited child has nothing left to gate on, and its exit watcher,
    // registered before this one, reported why.
    if (child.exitCode !== null || child.signalCode !== null) onSpawn();
  });
}

/** The one channel line a warm session writes when its CLI process fails on
 *  its own: the reason, the exit code or signal, the executable and the bounded
 *  stderr tail. It carries no environment value — the child environment is
 *  where the user's tokens sit, and this channel is mirrored into
 *  `.forge/sessions/*.jsonl`. */
export function cliProcessFailureLine(
  label: string,
  detail: string,
  executable: string,
  exit: CliProcessExit,
  signal: NodeJS.Signals | null,
  stderrTail: string,
): string {
  return (
    `[cli-agent] ${label} failed: ${detail}` +
    ` code=${exit.code ?? 'null'}` +
    ` signal=${signal ?? 'none'}` +
    ` exe=${executable}` +
    (stderrTail ? ` stderr=${stderrTail}` : '')
  );
}
