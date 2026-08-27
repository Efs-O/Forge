import * as readline from 'readline';
import { getLogger } from '../util/logger';
import { getCliAdapter } from './adapters';
import { spawnCliProcess, terminateCliProcessTree, waitForCliProcessExit } from './cliProcess';
import type {
  CliAccessMode,
  CliAgentEvent,
  CliAgentName,
  CliAgentRunResult,
  CliParseContext,
} from './types';

const log = getLogger();

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_CHARS = 4000;

export interface CliAgentRunOptions {
  cliName: CliAgentName;
  /** Resolved executable (see resolveCliExecutable) — this driver never resolves PATH itself. */
  executable: string;
  /** Extra argv tokens spawned before the adapter-built CLI args. Test-only
   *  hook so fixtures can front-load e.g. `[fixturePath]` when `executable`
   *  is `process.execPath` — production callers never set this. */
  argsPrefix?: string[];
  task: string;
  access: CliAccessMode;
  sessionId?: string;
  model?: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: CliAgentEvent) => void;
}

/**
 * Spawns a configured CLI (claude/codex) as a full-rights external agent for
 * one task, streams its parsed progress, and returns the final result. Forge
 * injects no tools here — the CLI runs its own agentic loop with its own
 * tools; this driver only relays stdout/exit status. Single owner of the
 * CLI-agent spawn/parse/cancel/timeout lifecycle (docs/plans/CONFIG_OVERHAUL_PLAN.md §4 step 7).
 */
export class CliAgentDriver {
  async run(options: CliAgentRunOptions): Promise<CliAgentRunResult> {
    const adapter = getCliAdapter(options.cliName);
    let finalText: string | undefined;
    let errorText: string | undefined;
    let sessionId: string | undefined;
    const stderrChunks: string[] = [];

    const ctx: CliParseContext = {
      emitText: (text) => options.onEvent?.({ kind: 'text', text }),
      emitStatus: (text) => options.onEvent?.({ kind: 'status', text }),
      setFinal: (text) => {
        finalText = text;
      },
      setError: (text) => {
        errorText = text;
      },
      setSessionId: (value) => {
        sessionId = value;
      },
    };

    const args = [
      ...(options.argsPrefix ?? []),
      ...adapter.buildArgs(options.task, options.access, {
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.model ? { model: options.model } : {}),
      }),
    ];

    const child = spawnCliProcess({
      executable: options.executable,
      args,
      cwd: options.cwd,
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    const rl = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined;
    rl?.on('line', (line) => {
      try {
        adapter.handleLine(line, ctx);
      } catch {
        // a malformed line from the CLI must never kill the run
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

    const stderrTail = stderrChunks.join('').slice(-STDERR_TAIL_CHARS);

    // Every terminal outcome is logged. Delegation used to fail in total silence:
    // two consecutive failures left no output-channel line and no coordination
    // event, so diagnosing them meant reading the model's private reasoning out
    // of state.vscdb. A delegate that cannot run must say so out loud.
    const outcome = (result: CliAgentRunResult): CliAgentRunResult => {
      if (result.status === 'completed') {
        log.info(`[cli-agent] ${options.cliName} (${options.access}) completed`);
      } else {
        log.warn(
          `[cli-agent] ${options.cliName} (${options.access}) ${result.status}: ${result.error ?? 'no detail'}`,
        );
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
