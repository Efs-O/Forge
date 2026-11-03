import * as readline from 'readline';
import { randomUUID } from 'crypto';
import type { ChildProcess } from 'node:child_process';
import { CLAUDE_SPAWN_ENV, claudeAdapter } from './adapters/claudeAdapter';
import { collectStderrTail } from './CliAgentDriver';
import { spawnCliProcess, terminateCliProcessTree, waitForCliProcessExit } from './cliProcess';
import { cliProcessFailureLine, waitForCliSpawn } from './cliStartFailure';
import { getLogger } from '../util/logger';
import type { CliAgentEvent, CliAgentRunResult, CliParseContext } from './types';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const log = getLogger();

export type CliAgentSessionState = 'starting' | 'idle' | 'running' | 'disposed';

export interface CliAgentSessionOptions {
  cliName?: 'claude' | 'codex';
  executable: string;
  argsPrefix?: string[];
  cwd: string;
  model?: string;
  /** Codex only: `agent_bus.codex_effort`, forwarded to `codexAppServerArgs`. */
  effort?: string;
  confirmedSessionId?: string;
  timeoutMs?: number;
}

export interface CliAgentSessionSendOptions {
  signal?: AbortSignal;
  onEvent?: (event: CliAgentEvent) => void;
}

interface ActiveTurn {
  resolve(result: CliAgentRunResult): void;
  finalText?: string;
  errorText?: string;
  observedSessionId?: string;
  cancelled: boolean;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort(): void;
  onEvent?: (event: CliAgentEvent) => void;
}

/** One warm Claude process owned by one conversation/model registry entry. */
export class CliAgentSession {
  private currentState: CliAgentSessionState = 'starting';
  private child: ReturnType<typeof spawnCliProcess> | undefined;
  private lines: readline.Interface | undefined;
  private active: ActiveTurn | undefined;
  private confirmedId: string | undefined;
  /** The start-failure message. Failure reporting prefers it over any write or
   *  protocol error, because those are consequences of the same missing
   *  program; cleared whenever a new process starts. */
  private startError: string | undefined;
  /** The current child's start outcome, created once with the process and
   *  awaited by every send. `spawn` is reported once, so a later send cannot
   *  attach fresh listeners and wait for it again. */
  private spawnGate: Promise<string | undefined> | undefined;
  /** Children whose termination we asked for (timeout, cancel, dispose, a
   *  protocol failure). The exit such a kill causes is the consequence of our
   *  own stop, not a CLI failure, so it must not add a second channel line to
   *  the message the turn already reports. */
  private readonly terminatedByUs = new WeakSet<ChildProcess>();

  constructor(private readonly options: CliAgentSessionOptions) {
    this.confirmedId = options.confirmedSessionId;
  }

  get state(): CliAgentSessionState {
    return this.currentState;
  }

  get confirmedSessionId(): string | undefined {
    return this.confirmedId;
  }

  async send(task: string, options: CliAgentSessionSendOptions = {}): Promise<CliAgentRunResult> {
    if (this.currentState === 'disposed') throw new Error('CLI agent session is disposed.');
    if (this.active) throw new Error('CLI agent session already has an active turn.');
    const child = this.child ?? this.startProcess();
    // startProcess() creates the gate together with the child, so it is set
    // whenever there is a child to write to.
    const gate = this.spawnGate!;
    if (!child?.stdin?.writable) {
      await this.handleTransportFailure('Claude CLI stdin is unavailable.');
      return { status: 'failed', finalText: '', error: 'Claude CLI stdin is unavailable.' };
    }

    this.currentState = 'running';
    return new Promise<CliAgentRunResult>((resolve) => {
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const onAbort = (): void => {
        if (!this.active) return;
        this.active.cancelled = true;
        void this.stopActiveProcess();
      };
      const turn: ActiveTurn = {
        resolve,
        cancelled: false,
        timedOut: false,
        timer: setTimeout(() => {
          if (!this.active) return;
          this.active.timedOut = true;
          void this.stopActiveProcess();
        }, timeoutMs),
        ...(options.signal ? { signal: options.signal } : {}),
        onAbort,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      };
      this.active = turn;
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // The turn slot is reserved above, before this await, so a second send in
      // the same tick still sees `this.active` and is refused rather than
      // starting a second process or overwriting this turn.
      void this.writeWhenSpawned(turn, child, gate, task);
    });
  }

  /** Writes the user message only once the child has reported `spawn`, so a
   *  missing executable produces the start failure and the write that would
   *  have reported `write EPIPE` never happens. The process-exit watcher owns
   *  the stop, the termination and the channel line, so this path adds no
   *  second terminate. */
  private async writeWhenSpawned(
    turn: ActiveTurn,
    child: ChildProcess,
    gate: Promise<string | undefined>,
    task: string,
  ): Promise<void> {
    const failure = await gate;
    if (this.active !== turn) return; // cancelled or stopped while the child was starting
    if (failure) return; // the exit watcher reports it; there is nothing to write
    if (!child.stdin?.writable) {
      void this.handleTransportFailure('Claude CLI stdin is unavailable.');
      return;
    }
    child.stdin.write(`${JSON.stringify(this.userMessage(task))}\n`, (error) => {
      if (error) void this.handleTransportFailure(`Claude CLI write failed: ${error.message}`);
    });
  }

  async dispose(): Promise<void> {
    if (this.currentState === 'disposed') return;
    this.currentState = 'disposed';
    await this.stopActiveProcess('CLI agent session disposed.');
  }

  private startProcess(): ChildProcess {
    this.currentState = 'starting';
    this.startError = undefined;
    const requestedId = this.confirmedId ?? randomUUID();
    const args = [
      ...(this.options.argsPrefix ?? []),
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      ...(this.confirmedId ? ['--resume', this.confirmedId] : ['--session-id', requestedId]),
    ];
    if (this.options.model) args.push('--model', this.options.model);
    const child = spawnCliProcess({
      executable: this.options.executable,
      args,
      cwd: this.options.cwd,
      env: CLAUDE_SPAWN_ENV,
      stdin: 'pipe',
    });
    this.child = child;
    // Created with the process, not per send: `spawn` is reported once, so a
    // warm session's next send awaits this same promise and is answered at
    // once instead of waiting for an event that already happened.
    this.spawnGate = waitForCliSpawn(child, 'Claude', this.options.executable, (message) => {
      this.startError = message;
    });
    // A pipe we write to needs an error handler: writing to a stdin whose
    // reader has already gone makes the stream emit `error`, and with no
    // listener that becomes an uncaught exception. The write callback reports
    // the same failure, so this only absorbs its duplicate.
    child.stdin?.on('error', () => undefined);
    this.lines = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined;
    this.lines?.on('line', (line) => this.handleLine(line));
    // Nothing read stderr before this, so a chatty CLI could fill the OS pipe
    // buffer and stall writing to it, and none of it survived to be logged.
    const stderr = collectStderrTail(child);
    void waitForCliProcessExit(child).then((exit) => {
      if (this.child !== child) return;
      const detail = exit.error
        ? `Claude CLI transport failed: ${exit.error.message}`
        : `Claude CLI exited with code ${exit.code ?? '?'}.`;
      // Exactly one channel line per failed process, and only for a failure the
      // CLI caused itself: a child we killed on timeout, cancel or dispose
      // already has its own message, and a clean exit is no failure at all.
      if (!this.terminatedByUs.has(child) && (exit.error || exit.code !== 0)) {
        log.warn(
          cliProcessFailureLine(
            'claude',
            detail,
            this.options.executable,
            exit,
            child.signalCode,
            stderr.tail(),
          ),
        );
      }
      void this.handleTransportFailure(detail);
    });
    this.currentState = 'idle';
    return child;
  }

  private handleLine(line: string): void {
    const turn = this.active;
    if (!turn) return;
    const ctx: CliParseContext = {
      emitText: (text) => turn.onEvent?.({ kind: 'text', text }),
      emitStatus: (text) => turn.onEvent?.({ kind: 'status', text }),
      setFinal: (text) => {
        turn.finalText = text;
        this.finishTurn('completed');
      },
      appendFinal: (text) => {
        turn.finalText = turn.finalText ? `${turn.finalText}\n${text}` : text;
      },
      setError: (text) => {
        turn.errorText = text;
        this.finishTurn('failed');
      },
      setSessionId: (sessionId) => {
        turn.observedSessionId = sessionId;
      },
    };
    try {
      claudeAdapter.handleLine(line, ctx);
    } catch (error) {
      void this.handleTransportFailure(
        `Claude CLI protocol failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private finishTurn(status: 'completed' | 'failed'): void {
    const turn = this.active;
    if (!turn) return;
    this.clearTurn(turn);
    if (status === 'completed' && turn.observedSessionId) {
      this.confirmedId = turn.observedSessionId;
    }
    this.currentState = 'idle';
    turn.resolve({
      status,
      finalText: turn.finalText ?? '',
      ...(turn.errorText ? { error: turn.errorText } : {}),
      ...(this.confirmedId ? { sessionId: this.confirmedId } : {}),
    });
  }

  private async stopActiveProcess(error = 'Cancelled.'): Promise<void> {
    // Captured before the await: a timeout and the dying child's exit event
    // each start a stop, and the caller may send the next turn in between.
    // The later stop must not close that turn's reader or resolve it.
    const { child, lines, active: turn } = this;
    if (child) {
      // Recorded before the await, so the exit this termination causes is
      // recognised as ours and writes no channel line.
      this.terminatedByUs.add(child);
      await terminateCliProcessTree(child);
    }
    if (this.child === child) {
      this.child = undefined;
      this.spawnGate = undefined;
    }
    if (this.lines === lines) this.lines = undefined;
    lines?.close();
    if (!turn || this.active !== turn) return;
    this.clearTurn(turn);
    if (this.currentState !== 'disposed') this.currentState = 'idle';
    // Retain the session id even though the turn did not complete. Claude
    // reports it in its init message, long before any timeout, and dropping it
    // here forced the next attempt to start a cold process — re-paying the
    // system prompt, tool schemas and CLAUDE.md as a prompt-cache miss. Keeping
    // it lets the next send() spawn with `--resume` and rejoin the transcript.
    if (turn.observedSessionId) this.confirmedId = turn.observedSessionId;
    const status = turn.timedOut ? 'timed_out' : turn.cancelled ? 'cancelled' : 'failed';
    // A process that never started outranks every later message: the write
    // error, the protocol error and the exit message are all consequences of
    // the same missing program, and until now whichever handler ran first
    // decided which one the user saw.
    const reported = status === 'failed' ? (this.startError ?? error) : error;
    turn.resolve({
      status,
      finalText: turn.finalText ?? '',
      error: turn.timedOut
        ? `Claude CLI exceeded ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout.`
        : reported,
      ...(this.confirmedId ? { sessionId: this.confirmedId } : {}),
    });
  }

  private async handleTransportFailure(error: string): Promise<void> {
    await this.stopActiveProcess(error);
  }

  private clearTurn(turn: ActiveTurn): void {
    clearTimeout(turn.timer);
    turn.signal?.removeEventListener('abort', turn.onAbort);
    if (this.active === turn) this.active = undefined;
  }

  private userMessage(text: string): object {
    return {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
  }
}
