/**
 * Wiring a spawned llama-server's stdio and lifecycle events to the log and the
 * output channel.
 *
 * Split out of `DirectBackend`, which keeps the model lifecycle. Everything
 * here is diagnostics: byte counters, a bounded stderr tail, and one exit
 * listener that covers startup failure, runtime crash and intentional
 * teardown alike.
 */

import type { ChildProcess } from 'child_process';
import { getLogger } from '../util/logger';

const log = getLogger();

const MAX_DIAGNOSTIC_TAIL_CHARS = 2_000;

/** Keep the LAST N chars of stderr, whitespace-collapsed: llama.cpp puts the
 *  real cause at the end, and the raw stream is heavily padded. */
function appendDiagnosticTail(previous: string, chunk: string): string {
  const normalized = chunk.replace(/\s+/g, ' ').trim();
  if (!normalized) return previous;
  return `${previous} ${normalized}`.slice(-MAX_DIAGNOSTIC_TAIL_CHARS);
}

export interface ServerDiagnosticsSink {
  append(text: string): void;
  appendLine(text: string): void;
}

export interface ServerDiagnosticsOptions {
  modelName: string;
  /** The shared llama-server output channel. */
  channel: () => ServerDiagnosticsSink;
  /**
   * Whether this process is still the backend's current one.
   * `stopLlamaServer` clears it before an intentional kill, which is how one
   * exit listener can tell a crash from a teardown.
   */
  isCurrent: () => boolean;
  /** A crash, not a teardown. `detail` is the assembled diagnostic line. */
  onUnexpectedExit: (detail: string) => void;
}

/** Attach stdout/stderr/error/exit/close listeners. Returns the start time so
 *  the caller can report total startup duration. */
export function attachServerDiagnostics(
  proc: ChildProcess,
  options: ServerDiagnosticsOptions,
): number {
  const { modelName, channel, isCurrent, onUnexpectedExit } = options;
  const startedAt = Date.now();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrTail = '';
  log.info(`[DirectBackend] llama-server spawned pid=${proc.pid ?? '?'} model=${modelName}`);

  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    channel()?.append(chunk.toString());
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderrBytes += chunk.byteLength;
    stderrTail = appendDiagnosticTail(stderrTail, text);
    channel()?.append(text);
  });
  proc.once('error', (err) => {
    log.error(
      `[DirectBackend] llama-server process error pid=${proc.pid ?? '?'} ` +
        `model=${modelName} after_ms=${Date.now() - startedAt}`,
      err,
    );
    channel()?.appendLine(`\n[ERROR] ${err.message}`);
  });
  proc.once('exit', (code, signal) => {
    const unexpected = isCurrent();
    const detail =
      `[DirectBackend] llama-server ${unexpected ? 'exited unexpectedly' : 'exited'} ` +
      `pid=${proc.pid ?? '?'} model=${modelName} code=${code ?? '?'} ` +
      `signal=${signal ?? '?'} after_ms=${Date.now() - startedAt} ` +
      `stdout_bytes=${stdoutBytes} stderr_bytes=${stderrBytes}` +
      (stderrTail ? ` stderr_tail=${JSON.stringify(stderrTail)}` : '');
    if (unexpected) {
      log.error(detail);
      channel()?.appendLine(`\n[Forge] ${detail}`);
      onUnexpectedExit(detail);
    } else {
      log.info(detail);
    }
  });
  proc.once('close', (code, signal) => {
    log.debug(
      `[DirectBackend] llama-server stdio closed pid=${proc.pid ?? '?'} ` +
        `model=${modelName} code=${code ?? '?'} signal=${signal ?? '?'}`,
    );
  });
  return startedAt;
}
