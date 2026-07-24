import { spawn, type ChildProcess } from 'child_process';
import * as readline from 'readline';
import { getCliAdapter } from './adapters';
import { buildWindowsCmdShellInvocation, needsWindowsCmdShellWrap } from './windowsCmdShim';
import type {
  CliAccessMode,
  CliAgentEvent,
  CliAgentName,
  CliAgentRunResult,
  CliParseContext,
} from './types';

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

/** Kills a spawned CLI agent's process tree. Mirrors DirectBackend's
 *  killLlamaProcess convention (backend/llamaProcess.ts): Windows uses
 *  best-effort kill() then `taskkill /T /F`; POSIX sends SIGTERM then
 *  SIGKILL after a grace period. Never hangs past a 6s overall deadline. */
function killCliProcessTree(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    proc.once('exit', finish);
    proc.once('error', finish);

    if (process.platform === 'win32' && proc.pid) {
      try {
        proc.kill();
      } catch {
        // ignore and fall through to taskkill
      }
      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
      });
      killer.once('exit', () => setTimeout(finish, 250));
      killer.once('error', () => setTimeout(finish, 250));
    } else {
      try {
        proc.kill('SIGTERM');
      } catch {
        finish();
        return;
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // process likely already exited
        }
      }, 5000);
    }
    setTimeout(finish, 6000);
  });
}

/**
 * Spawns a configured CLI (claude/codex) as a full-rights external agent for
 * one task, streams its parsed progress, and returns the final result. Forge
 * injects no tools here — the CLI runs its own agentic loop with its own
 * tools; this driver only relays stdout/exit status. Single owner of the
 * CLI-agent spawn/parse/cancel/timeout lifecycle (CONFIG_OVERHAUL_PLAN.md §4 step 7).
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

    // npm-installed claude/codex ship as .cmd shims on Windows, which Node
    // cannot CreateProcess directly (unlike llama-server, a real .exe — see
    // DirectBackend). Route those through cmd.exe with a manually quoted
    // command line — see windowsCmdShim.ts for why shell:true is unsafe here.
    const wrap = process.platform === 'win32' && needsWindowsCmdShellWrap(options.executable);
    const { file: spawnFile, args: spawnArgs } = wrap
      ? buildWindowsCmdShellInvocation(options.executable, args)
      : { file: options.executable, args };
    const child = spawn(spawnFile, spawnArgs, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(wrap ? { windowsVerbatimArguments: true } : {}),
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
      void killCliProcessTree(child);
    }, timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      void killCliProcessTree(child);
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const exit = await new Promise<{ code: number | null; err?: Error }>((resolve) => {
      child.once('exit', (code) => resolve({ code }));
      child.once('error', (err) => resolve({ code: null, err }));
    });
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    rl?.close();

    const stderrTail = stderrChunks.join('').slice(-STDERR_TAIL_CHARS);

    if (exit.err) {
      return {
        status: 'failed',
        finalText: '',
        error: `${options.cliName} CLI failed to start: ${exit.err.message}`,
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (cancelled) {
      return {
        status: 'cancelled',
        finalText: finalText ?? '',
        error: 'Cancelled.',
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (timedOut) {
      return {
        status: 'timed_out',
        finalText: finalText ?? '',
        error: `${options.cliName} CLI exceeded ${timeoutMs}ms timeout.`,
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (errorText) {
      return {
        status: 'failed',
        finalText: finalText ?? '',
        error: errorText,
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (exit.code !== 0) {
      return {
        status: 'failed',
        finalText: finalText ?? '',
        error: `${options.cliName} CLI exited with code ${exit.code ?? '?'}${stderrTail ? `: ${stderrTail}` : ''}`,
        ...(sessionId ? { sessionId } : {}),
      };
    }
    return { status: 'completed', finalText: finalText ?? '', ...(sessionId ? { sessionId } : {}) };
  }
}
