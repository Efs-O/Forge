import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { claudeAdapter } from './adapters/claudeAdapter';
import { spawnCliProcess, terminateCliProcessTree, waitForCliProcessExit } from './cliProcess';
import type { CliAccessMode, CliAgentEvent, CliAgentRunResult, CliParseContext } from './types';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type CliAgentSessionState = 'starting' | 'idle' | 'running' | 'disposed';

export interface CliAgentSessionOptions {
  cliName?: 'claude' | 'codex';
  executable: string;
  argsPrefix?: string[];
  access: CliAccessMode;
  cwd: string;
  model?: string;
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
    if (!this.child) this.startProcess();
    const child = this.child;
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
      child.stdin!.write(`${JSON.stringify(this.userMessage(task))}\n`, (error) => {
        if (error) void this.handleTransportFailure(`Claude CLI write failed: ${error.message}`);
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.currentState === 'disposed') return;
    this.currentState = 'disposed';
    await this.stopActiveProcess('CLI agent session disposed.');
  }

  private startProcess(): void {
    this.currentState = 'starting';
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
      this.options.access === 'full'
        ? 'bypassPermissions'
        : this.options.access === 'write'
          ? 'acceptEdits'
          : 'plan',
      ...(this.confirmedId ? ['--resume', this.confirmedId] : ['--session-id', requestedId]),
    ];
    if (this.options.model) args.push('--model', this.options.model);
    const child = spawnCliProcess({
      executable: this.options.executable,
      args,
      cwd: this.options.cwd,
      stdin: 'pipe',
    });
    this.child = child;
    this.lines = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined;
    this.lines?.on('line', (line) => this.handleLine(line));
    void waitForCliProcessExit(child).then((exit) => {
      if (this.child !== child) return;
      const detail = exit.error
        ? `Claude CLI transport failed: ${exit.error.message}`
        : `Claude CLI exited with code ${exit.code ?? '?'}.`;
      void this.handleTransportFailure(detail);
    });
    this.currentState = 'idle';
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
    const child = this.child;
    if (child) await terminateCliProcessTree(child);
    if (this.child === child) this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    const turn = this.active;
    if (!turn) return;
    this.clearTurn(turn);
    if (this.currentState !== 'disposed') this.currentState = 'idle';
    // Retain the session id even though the turn did not complete. Claude
    // reports it in its init message, long before any timeout, and dropping it
    // here forced the next attempt to start a cold process — re-paying the
    // system prompt, tool schemas and CLAUDE.md as a prompt-cache miss. Keeping
    // it lets the next send() spawn with `--resume` and rejoin the transcript.
    if (turn.observedSessionId) this.confirmedId = turn.observedSessionId;
    const status = turn.timedOut ? 'timed_out' : turn.cancelled ? 'cancelled' : 'failed';
    turn.resolve({
      status,
      finalText: turn.finalText ?? '',
      error: turn.timedOut
        ? `Claude CLI exceeded ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout.`
        : error,
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
