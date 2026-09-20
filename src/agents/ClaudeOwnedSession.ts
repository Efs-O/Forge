import * as readline from 'readline';
import { spawnCliProcess, terminateProcessTree, waitForCliProcessExit } from './cliProcess';
import type { CliAgentRunResult } from './types';

/**
 * A Forge-owned, persistent Claude Code session (AGENT_MESH_PLAN §0, P4).
 *
 * Mirrors the lifecycle of the owned Codex app-server (`CodexAppServerSession`):
 * one warm process this window owns, addressed by its session id, with the same
 * `state` / `confirmedSessionId` / `pid` / `send()` / `dispose()` surface. The
 * transport is the Claude CLI's **streaming input mode** — a long-lived
 * `claude -p --input-format stream-json --output-format stream-json` process
 * that stays open across turns (not one-shot `--print --resume`, which drops
 * intermediate turns). Forge writes one user message per turn and reads the
 * stream until the `result` message that ends it.
 *
 * The session id arrives in the `system` init message at startup and is echoed
 * in every `result`; it is what makes "warm" survive a restart (the ownership
 * record keeps it, and a later spawn passes `--resume <id>`, M3).
 *
 * This is a v1 enhancement, separately tested (P4): it lands only when its own
 * tests pass, and it does not block the Codex path.
 */

export interface ClaudeOwnedSessionOptions {
  /** The resolved `claude` executable. */
  executable: string;
  /** Working directory (the workspace root). */
  cwd: string;
  /** Resume this session id on startup (M3: warm survives a restart). */
  confirmedSessionId?: string;
  /** Model to run (optional; the CLI default otherwise). */
  model?: string;
  /** Permission mode for an unattended owned session. */
  permissionMode?: string;
  /**
   * Extra args appended after the fixed flags (tests inject the fake-CLI
   * fixture here, the way `CodexAppServerSession` takes `argsPrefix`).
   */
  argsPrefix?: string[];
}

interface ActiveTurn {
  text: string;
  resolve: (r: CliAgentRunResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  interrupted: boolean;
}

/**
 * The persistent owned Claude session. `send()` starts a turn and resolves at
 * the `result` message; it throws when a turn is already active (the per-alias
 * FIFO is the only caller and never does that, M5).
 */
export class ClaudeOwnedSession {
  private lifecycle: 'starting' | 'idle' | 'running' | 'disposed' = 'starting';
  private child: ReturnType<typeof spawnCliProcess> | undefined;
  private input: readline.Interface | undefined;
  private active: ActiveTurn | undefined;
  private sessionId: string | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(private readonly options: ClaudeOwnedSessionOptions) {
    this.sessionId = options.confirmedSessionId;
  }

  get state(): string {
    return this.lifecycle;
  }

  /** The confirmed session id (from the init message, or the resume id). */
  get confirmedSessionId(): string | undefined {
    return this.sessionId;
  }

  /** The child process pid, when the session is running (ownership records). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  async send(task: string, options: { signal?: AbortSignal } = {}): Promise<CliAgentRunResult> {
    if (this.lifecycle === 'disposed') throw new Error('Claude owned session is disposed.');
    if (this.active) throw new Error('Claude owned session already has an active turn.');
    await this.ensureStarted();
    this.lifecycle = 'running';
    return new Promise<CliAgentRunResult>((resolve) => {
      const onAbort = (): void => {
        if (!this.active) return;
        this.active.interrupted = true;
        // Streaming input has no interrupt RPC; the turn ends on its own or on
        // dispose. Marking it lets the result resolve as cancelled.
      };
      const active: ActiveTurn = {
        text: '',
        resolve,
        interrupted: false,
        ...(options.signal ? { signal: options.signal, onAbort } : {}),
      };
      this.active = active;
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      this.writeUserMessage(task);
    });
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === 'disposed') return;
    this.lifecycle = 'disposed';
    await this.stop('Claude owned session disposed.');
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start();
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const args = [
      ...(this.options.argsPrefix ?? []),
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(this.options.confirmedSessionId ? ['--resume', this.options.confirmedSessionId] : []),
      ...(this.options.model ? ['--model', this.options.model] : []),
      ...(this.options.permissionMode ? ['--permission-mode', this.options.permissionMode] : []),
    ];
    const child = spawnCliProcess({
      executable: this.options.executable,
      args,
      cwd: this.options.cwd,
      stdin: 'pipe',
    });
    this.child = child;
    this.input = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined;
    this.input?.on('line', (line) => this.handleLine(line));
    void waitForCliProcessExit(child).then((exit) => {
      if (this.child !== child) return;
      void this.failProtocol(
        exit.error
          ? `Claude owned session transport failed: ${exit.error.message}`
          : `Claude owned session exited with code ${exit.code ?? '?'}.`,
      );
    });
    // Streaming input has no initialize handshake: the session is ready once
    // the process is up. The first user message is sent by send().
    this.lifecycle = 'idle';
  }

  private writeUserMessage(text: string): void {
    if (!this.child?.stdin?.writable) {
      void this.failProtocol('Claude owned session stdin is unavailable.');
      return;
    }
    const frame = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) void this.failProtocol(`Claude owned session write failed: ${error.message}`);
    });
  }

  private handleLine(line: string): void {
    if (line.trim() === '') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // stream-json stdout is line-delimited JSON; a line that is not a JSON
      // frame is a protocol error (the Codex session fails the same way). A
      // stray warning would go to stderr, not stdout.
      void this.failProtocol('Claude owned session emitted malformed JSON output.');
      return;
    }
    const type = msg['type'];
    if (type === 'system') {
      const sid = msg['session_id'];
      if (typeof sid === 'string' && sid) this.sessionId = sid;
      return;
    }
    if (type === 'assistant') {
      const message = msg['message'];
      const content =
        message && typeof message === 'object'
          ? (message as Record<string, unknown>)['content']
          : undefined;
      if (Array.isArray(content) && this.active) {
        for (const block of content) {
          if (block && typeof block === 'object' && block['type'] === 'text') {
            const text = (block as Record<string, unknown>)['text'];
            if (typeof text === 'string') this.active.text += text;
          }
        }
      }
      return;
    }
    if (type === 'result') void this.finishFromResult(msg);
  }

  private async finishFromResult(msg: Record<string, unknown>): Promise<void> {
    const active = this.active;
    if (!active) return;
    const sid = msg['session_id'];
    if (typeof sid === 'string' && sid) this.sessionId = sid;
    const subtype = msg['subtype'];
    const result = msg['result'];
    if (typeof result === 'string') active.text = result;
    const status =
      subtype === 'success'
        ? active.interrupted
          ? 'cancelled'
          : 'completed'
        : active.interrupted
          ? 'cancelled'
          : 'failed';
    this.clearActive(active);
    this.lifecycle = 'idle';
    active.resolve({
      status,
      finalText: active.text,
      ...(status !== 'completed'
        ? {
            error:
              status === 'cancelled' ? 'Cancelled.' : `Claude turn ${String(subtype ?? 'failed')}.`,
          }
        : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
  }

  private clearActive(active: ActiveTurn): void {
    if (active.signal && active.onAbort) active.signal.removeEventListener('abort', active.onAbort);
    if (this.active === active) this.active = undefined;
  }

  private async failProtocol(message: string): Promise<void> {
    await this.stop(message);
  }

  private async stop(message: string): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.input?.close();
    this.input = undefined;
    const active = this.active;
    if (active) {
      this.clearActive(active);
      active.resolve({
        status: 'failed',
        finalText: active.text,
        error: message,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      });
    }
    if (child) await terminateProcessTree(child);
    if (this.lifecycle !== 'disposed') this.lifecycle = 'idle';
  }
}
