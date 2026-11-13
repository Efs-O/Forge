import * as readline from 'readline';
import type { ChildProcess } from 'node:child_process';
import { getLogger } from '../util/logger';
import { getCliAdapter } from './adapters';
import { spawnCliProcess, terminateCliProcessTree, waitForCliProcessExit } from './cliProcess';
import type { CliAgentEvent, CliAgentName, CliAgentRunResult, CliParseContext } from './types';

const log = getLogger();

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Characters of CLI stderr a failed run keeps and reports. The single cap for
 *  every CLI-agent path — this driver and both warm chat sessions — so a
 *  verbose CLI cannot grow the retained tail without bound. */
export const STDERR_TAIL_CHARS = 4000;

/** Drains a child's stderr into a bounded tail.
 *  A pipe nobody reads fills the OS buffer and stalls the writer, so every
 *  path that spawns a CLI has to consume stderr even when only the last few
 *  kilobytes are worth reporting. `sink` is the driver's live pass-through to
 *  its caller; the warm sessions pass none. Only the last STDERR_TAIL_CHARS
 *  characters survive. */
export function collectStderrTail(
  child: ChildProcess,
  sink?: (text: string) => void,
): { readonly tail: () => string } {
  let buffered = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    buffered = (buffered + chunk).slice(-STDERR_TAIL_CHARS);
    sink?.(chunk);
  });
  return { tail: () => buffered };
}

export interface CliAgentRunOptions {
  cliName: CliAgentName;
  /** Resolved executable (see resolveCliExecutable) — this driver never resolves PATH itself. */
  executable: string;
  /** Extra argv tokens spawned before the adapter-built CLI args. Test-only
   *  hook so fixtures can front-load e.g. `[fixturePath]` when `executable`
   *  is `process.execPath` — production callers never set this. */
  argsPrefix?: string[];
  task: string;
  sessionId?: string;
  createSessionId?: string;
  sessionTitle?: string;
  model?: string;
  effort?: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: CliAgentEvent) => void;
  /** Raw protocol capture for headless integrations; the adapter still owns parsing. */
  onStdoutLine?: (line: string) => void;
  onStderr?: (text: string) => void;
  onSessionId?: (sessionId: string) => void;
  onSpawned?: () => void;
}

/**
 * Spawns a configured CLI (claude/codex) as a full-rights external agent for
 * one task, streams its parsed progress, and returns the final result. Forge
 * injects no tools here — the CLI runs its own agentic loop with its own
 * tools; this driver only relays stdout/exit status.
 * Single owner of the CLI-agent spawn/parse/cancel/timeout lifecycle
 * (docs/plans/CONFIG_OVERHAUL_PLAN.md §4 step 7).
 */
export class CliAgentDriver {
  async run(options: CliAgentRunOptions): Promise<CliAgentRunResult> {
    const adapter = getCliAdapter(options.cliName);
    let finalText: string | undefined;
    let errorText: string | undefined;
    let sessionId: string | undefined = options.sessionId ?? options.createSessionId;
    let protocolError: string | undefined;

    const ctx: CliParseContext = {
      emitText: (text) => options.onEvent?.({ kind: 'text', text }),
      emitStatus: (text) => options.onEvent?.({ kind: 'status', text }),
      setFinal: (text) => {
        finalText = text;
      },
      appendFinal: (text) => {
        finalText = finalText ? `${finalText}\n${text}` : text;
      },
      setError: (text) => {
        errorText = text;
      },
      setSessionId: (value) => {
        sessionId = value;
        options.onSessionId?.(value);
      },
    };

    const args = [
      ...(options.argsPrefix ?? []),
      ...adapter.buildArgs(options.task, {
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.createSessionId ? { createSessionId: options.createSessionId } : {}),
        ...(options.sessionTitle ? { sessionTitle: options.sessionTitle } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      }),
    ];

    const child = spawnCliProcess({
      executable: options.executable,
      args,
      cwd: options.cwd,
      ...(adapter.spawnEnv ? { env: adapter.spawnEnv } : {}),
    });
    options.onSpawned?.();
    const stderr = collectStderrTail(child, (text) => options.onStderr?.(text));

    const rl = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined;
    rl?.on('line', (line) => {
      options.onStdoutLine?.(line);
      try {
        adapter.handleLine(line, ctx);
      } catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        void terminateCliProcessTree(child);
      }
    });

    let timedOut = false;
    let cancelled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateCliProcessTree(child);
    }, timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      void terminateCliProcessTree(child);
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const exit = await waitForCliProcessExit(child);
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    rl?.close();

    const stderrTail = stderr.tail();

    // Every terminal outcome is logged. Delegation used to fail in total silence:
    // two consecutive failures left no output-channel line and no coordination
    // event, so diagnosing them meant reading the model's private reasoning out
    // of state.vscdb. A delegate that cannot run must say so out loud.
    const outcome = (result: CliAgentRunResult): CliAgentRunResult => {
      if (result.status === 'completed') {
        log.info(`[cli-agent] ${options.cliName} completed`);
      } else {
        log.warn(`[cli-agent] ${options.cliName} ${result.status}: ${result.error ?? 'no detail'}`);
      }
      return result;
    };

    if (exit.error) {
      return outcome({
        status: 'failed',
        finalText: '',
        error: `${options.cliName} CLI failed to start: ${exit.error.message}`,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    if (cancelled) {
      return outcome({
        status: 'cancelled',
        finalText: finalText ?? '',
        error: 'Cancelled.',
        ...(sessionId ? { sessionId } : {}),
      });
    }
    if (timedOut) {
      return outcome({
        status: 'timed_out',
        finalText: finalText ?? '',
        error: `${options.cliName} CLI exceeded ${timeoutMs}ms timeout.`,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    if (errorText) {
      return outcome({
        status: 'failed',
        finalText: finalText ?? '',
        error: errorText,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    if (protocolError) {
      return outcome({
        status: 'failed',
        finalText: finalText ?? '',
        error: `${options.cliName} CLI emitted an invalid protocol message: ${protocolError}`,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    if (exit.code !== 0) {
      return outcome({
        status: 'failed',
        finalText: finalText ?? '',
        error: `${options.cliName} CLI exited with code ${exit.code ?? '?'}${stderrTail ? `: ${stderrTail}` : ''}`,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    return outcome({
      status: 'completed',
      finalText: finalText ?? '',
      ...(sessionId ? { sessionId } : {}),
    });
  }
}
