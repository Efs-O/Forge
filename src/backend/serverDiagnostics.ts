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

/** Out-of-memory signatures from llama.cpp / CUDA / Vulkan, matched as whole
 *  phrases — never a bare word that a path or model name could contain. */
const OOM_SIGNATURES = [
  /\bout of memory\b/i,
  /\bcudaMalloc failed\b/i,
  /\bfailed to allocate\b/i,
  /\bunable to allocate\b/i,
];

const STARTUP_TAIL_CHARS = 300;

/**
 * The cause to append to "llama-server failed to start". Before this, a model
 * that did not fit said only `exited with code N` — the reason sat in the
 * output channel. With `n_gpu_layers: 999` a model too big for VRAM is a hard
 * load failure rather than a silent CPU spill, so the message names the knobs.
 */
export function describeStartupFailure(stderrTail: string): string {
  const tail = stderrTail.trim();
  if (!tail) return '';
  if (OOM_SIGNATURES.some((signature) => signature.test(tail))) {
    return (
      ' — out of GPU memory: the model does not fit. In config.yaml lower ' +
      '`n_gpu_layers` (per model, or `llama_server.n_gpu_layers`; 999 = every ' +
      'layer on the GPU) to offload fewer layers, or lower `num_ctx`.'
    );
  }
  return ` — ${tail.slice(-STARTUP_TAIL_CHARS)}`;
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

export interface ServerDiagnostics {
  /** For the caller's total startup duration. */
  startedAt: number;
  /** The bounded stderr tail so far — the cause of a failed start. */
  stderrTail: () => string;
}

/** Attach stdout/stderr/error/exit/close listeners. */
export function attachServerDiagnostics(
  proc: ChildProcess,
  options: ServerDiagnosticsOptions,
): ServerDiagnostics {
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
  return { startedAt, stderrTail: () => stderrTail };
}
