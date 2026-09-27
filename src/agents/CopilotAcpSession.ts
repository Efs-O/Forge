import * as readline from 'readline';
import { spawnCliProcess, terminateProcessTree, waitForCliProcessExit } from './cliProcess';
import { JsonRpcPending, routeJsonRpcLine } from './jsonRpcStdio';
import {
  applyCopilotSessionUpdate,
  copilotPromptStopReason,
  validateCopilotInitResult,
  validateCopilotSessionResult,
} from './copilotAcpProtocol';
import {
  copilotTurnStatus,
  createCopilotTurn,
  settleCopilotTurn,
  type CopilotActiveTurn,
} from './copilotAcpTurn';
import type { CliAgentRunResult } from './types';

/**
 * A Forge-owned GitHub Copilot CLI session over ACP stdio
 * (docs/plans/COPILOT_AGENT_MESH_PLAN.md P1, protocol fixed by
 * docs/reports/COPILOT_CLI_TRANSPORT_SPIKE.md).
 *
 * One warm `copilot --acp --stdio --no-remote --allow-all` child per session,
 * addressed by its confirmed ACP session id. The transport is newline-
 * delimited JSON-RPC (the ACP v1 wire shape), so id correlation and line
 * framing are shared with the Codex app-server (`jsonRpcStdio`); everything
 * above that is Copilot's own protocol.
 *
 * The public `send()` promise settles exactly once, through the turn
 * (`copilotAcpTurn`): a correlated `session/prompt` response, a pre-prompt
 * abort, a timeout, a cancel-grace expiry, a crash, or a dispose. Protocol
 * rules (validation, update routing, stop reasons) live in
 * `copilotAcpProtocol`.
 */

export interface CopilotAcpSessionOptions {
  /** The resolved `copilot` executable. */
  executable: string;
  /** Working directory (the workspace root). Also passed to session/new|load. */
  cwd: string;
  /** Resume this confirmed ACP session id on startup (session/load). */
  confirmedSessionId?: string;
  /**
   * Extra args appended after the fixed flags (tests inject the fake-CLI
   * fixture here, the way `CodexAppServerSession` takes `argsPrefix`).
   */
  argsPrefix?: string[];
  /** Per-turn deadline; the timeout takes the same cancel path as abort. */
  timeoutMs?: number;
  /** Bounded grace after `session/cancel` before the owned child is killed. */
  cancelGraceMs?: number;
}

export interface CopilotAcpSendOptions {
  signal?: AbortSignal;
  onEvent?: (event: { kind: 'text' | 'status'; text: string }) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;

export class CopilotAcpSession {
  private lifecycle: 'starting' | 'idle' | 'running' | 'disposed' = 'starting';
  private child: ReturnType<typeof spawnCliProcess> | undefined;
  private input: readline.Interface | undefined;
  private active: CopilotActiveTurn | undefined;
  private sessionId: string | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly pending = new JsonRpcPending();
  private readonly cancelTimers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Request ids rejected by a deliberate stop (transport teardown). A late
   * response for one of these ids is ignored; any other unknown id is a
   * protocol error.
   */
  private readonly stoppedRequestIds = new Set<number>();

  constructor(private readonly options: CopilotAcpSessionOptions) {
    this.sessionId = options.confirmedSessionId;
  }

  get state(): string {
    return this.lifecycle;
  }

  /** The confirmed ACP session id (from session/new|load, or the resume id). */
  get confirmedSessionId(): string | undefined {
    return this.sessionId;
  }

  /** The child process pid, when the ACP server is running (ownership records). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  async send(task: string, options: CopilotAcpSendOptions = {}): Promise<CliAgentRunResult> {
    if (this.lifecycle === 'disposed') throw new Error('Copilot ACP session is disposed.');
    if (this.active) throw new Error('Copilot ACP session already has an active turn.');
    // The turn (and its public promise) is created synchronously, so the
    // active slot is reserved before the cold-start await: two concurrent
    // first sends cannot both issue a session/prompt on one session.
    const active = createCopilotTurn({
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
    this.active = active;
    active.onAbort = (): void => {
      if (this.active !== active) return;
      active.interrupted = true;
      this.cancelActive(active);
    };
    if (options.signal?.aborted) {
      // Aborted before the turn started: settle as cancelled now — no prompt,
      // no cancel, no child.
      active.interrupted = true;
      this.settleStoppedTurn(active);
      return active.promise;
    }
    options.signal?.addEventListener('abort', active.onAbort, { once: true });
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    active.timer = setTimeout(() => {
      if (this.active !== active) return;
      active.timedOut = true;
      this.cancelActive(active);
    }, timeoutMs);
    try {
      await this.ensureStarted();
    } catch (error) {
      if (active.settled) return active.promise;
      // Startup validation failure: the transport is alive but unusable.
      // Reject the public turn; dispose() tears the child down.
      this.releaseTurn(active);
      throw error;
    }
    // An abort/interrupt that arrived before the prompt went out settles the
    // turn as cancelled now — there is no prompt to cancel.
    if (active.interrupted) {
      this.settleStoppedTurn(active);
      return active.promise;
    }
    this.lifecycle = 'running';
    active.promptSent = true;
    void this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: task }],
    })
      .then((result) => {
        if (this.active === active) this.finishFromPromptResponse(active, result);
      })
      .catch((error) => {
        if (this.active === active) void this.failProtocol(error.message);
      });
    return active.promise;
  }

  /**
   * Interrupt the active turn (a `priority=steer` message). Before the prompt
   * went out the turn settles as cancelled with nothing to cancel; after, one
   * `session/cancel` notification is sent and the turn settles on the
   * correlated prompt response (`stopReason: cancelled`) or the owned child is
   * terminated after the bounded grace period.
   */
  interrupt(): void {
    const active = this.active;
    if (!active) return;
    active.interrupted = true;
    this.cancelActive(active);
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === 'disposed') return;
    this.lifecycle = 'disposed';
    // A dispose during an active turn settles it as cancelled (the turn is
    // abandoned, not a protocol failure) and terminates the owned child.
    const active = this.active;
    if (active) {
      active.interrupted = true;
      this.settleStoppedTurn(active);
    }
    await this.stop('Copilot ACP session disposed.');
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start();
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const args = [
      ...(this.options.argsPrefix ?? []),
      '--acp',
      '--stdio',
      '--no-remote',
      '--allow-all',
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
      // A clean exit (code 0, no error) after a successful stop is not a
      // protocol failure — the transport is already torn down.
      if (exit.error || (exit.code ?? 0) !== 0) {
        void this.failProtocol(
          exit.error
            ? `Copilot ACP transport failed: ${exit.error.message}`
            : `Copilot ACP exited with code ${exit.code ?? '?'}.`,
        );
      }
    });
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    validateCopilotInitResult(init);
    if (this.sessionId) {
      const result = await this.request('session/load', {
        sessionId: this.sessionId,
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.sessionId = validateCopilotSessionResult(result, 'session/load', this.sessionId);
    } else {
      const result = await this.request('session/new', {
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.sessionId = validateCopilotSessionResult(result, 'session/new');
    }
    this.lifecycle = 'idle';
  }

  private request(method: string, params: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.pending.open(method, resolve, reject);
      this.write({ id, method, params });
    });
  }

  /** A JSON-RPC notification: no id, no pending promise. */
  private notify(method: string, params?: object): void {
    this.write(params ? { method, params } : { method });
  }

  private write(message: object): void {
    if (!this.child?.stdin?.writable) {
      void this.failProtocol('Copilot ACP stdin is unavailable.');
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) void this.failProtocol(`Copilot ACP write failed: ${error.message}`);
    });
  }

  private handleLine(line: string): void {
    routeJsonRpcLine(line, this.pending, {
      onRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onNotification: (method, params) => this.handleNotification(method, params),
      onProtocolError: (message) => void this.failProtocol(message),
      onUnmatchedResponse: (id) => {
        // A late response for a request the session deliberately stopped is
        // not a protocol failure; any other unknown id is.
        if (this.stoppedRequestIds.delete(id)) return;
        void this.failProtocol(`Copilot ACP response ${id} has no matching request.`);
      },
    });
  }

  /**
   * ACP server-initiated requests. `session/request_permission` is answered
   * defensively with a cancelled outcome: `--allow-all` should prevent normal
   * prompts, and an unanswered request would deadlock a headless turn.
   */
  private handleServerRequest(id: number, method: string, _rawParams: unknown): void {
    if (method === 'session/request_permission') {
      this.write({ id, result: { outcome: { outcome: 'cancelled' } } });
      const active = this.active;
      if (active) {
        active.onEvent?.({ kind: 'status', text: '[copilot: permission request cancelled]' });
        active.interrupted = true;
        this.cancelActive(active);
      }
      return;
    }
    void this.failProtocol(`Copilot ACP unexpected server request ${method}.`);
  }

  private handleNotification(method: string, rawParams: unknown): void {
    if (method !== 'session/update') return;
    const active = this.active;
    if (!active) return;
    applyCopilotSessionUpdate(
      rawParams,
      active,
      this.sessionId,
      (message) => void this.failProtocol(message),
    );
  }

  /**
   * The correlated `session/prompt` response is the terminal truth for the
   * active turn. `end_turn` → completed, `cancelled` → cancelled, anything
   * else → failed.
   */
  private finishFromPromptResponse(active: CopilotActiveTurn, result: unknown): void {
    const stopReason = copilotPromptStopReason(result);
    if (typeof stopReason !== 'string') {
      void this.failProtocol('Copilot session/prompt returned no stopReason.');
      return;
    }
    this.active = undefined;
    const status = active.timedOut
      ? 'timed_out'
      : stopReason === 'end_turn'
        ? 'completed'
        : stopReason === 'cancelled'
          ? 'cancelled'
          : 'failed';
    settleCopilotTurn(active, {
      status,
      finalText: active.text,
      ...(status !== 'completed'
        ? {
            error:
              status === 'cancelled'
                ? 'Cancelled.'
                : status === 'timed_out'
                  ? `Copilot ACP exceeded ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout.`
                  : `Copilot turn stopped with reason ${stopReason}.`,
          }
        : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
    if (this.lifecycle !== 'disposed') this.lifecycle = 'idle';
  }

  /**
   * One `session/cancel` notification for the active turn, then a bounded
   * grace period before terminating the owned child — only if no terminal
   * response arrived. Before the prompt went out, the turn simply settles as
   * cancelled. The child is the process Forge spawned; nothing else is touched.
   */
  private cancelActive(active: CopilotActiveTurn): void {
    if (this.active !== active) return;
    if (!active.promptSent) {
      this.settleStoppedTurn(active);
      return;
    }
    if (active.cancelSent) return;
    active.cancelSent = true;
    this.notify('session/cancel', { sessionId: this.sessionId ?? '' });
    const graceMs = this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    const timer = setTimeout(() => {
      this.cancelTimers.delete(timer);
      if (this.active === active) void this.stop('Copilot ACP cancel did not settle in time.');
    }, graceMs);
    this.cancelTimers.add(timer);
  }

  /**
   * Settles the active turn from a stop path (pre-prompt abort, dispose,
   * permission-request cancel) — exactly once, status from the turn flags.
   */
  private settleStoppedTurn(active: CopilotActiveTurn): void {
    if (this.active === active) this.active = undefined;
    const status = copilotTurnStatus(active);
    settleCopilotTurn(active, {
      status,
      finalText: active.text,
      error:
        status === 'timed_out'
          ? `Copilot ACP exceeded ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout.`
          : status === 'cancelled'
            ? 'Cancelled.'
            : 'Copilot ACP turn stopped.',
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
    if (this.lifecycle !== 'disposed') this.lifecycle = 'idle';
  }

  private failProtocol(message: string): Promise<void> {
    return this.stop(message);
  }

  /**
   * Tears down the transport: rejects every in-flight request (recording the
   * stopped ids), settles the active turn exactly once, and terminates the
   * owned child. Idempotent — a second call finds no child, no pending, no
   * active turn.
   */
  private stop(message: string): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.input?.close();
    this.input = undefined;
    for (const timer of this.cancelTimers) clearTimeout(timer);
    this.cancelTimers.clear();
    for (const id of this.pending.rejectAll(new Error(message))) this.stoppedRequestIds.add(id);
    const active = this.active;
    if (active) {
      this.active = undefined;
      const status = copilotTurnStatus(active);
      settleCopilotTurn(active, {
        status,
        finalText: active.text,
        error:
          status === 'timed_out'
            ? `Copilot ACP exceeded ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout.`
            : status === 'cancelled'
              ? 'Cancelled.'
              : message,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      });
    }
    if (this.lifecycle !== 'disposed') this.lifecycle = 'idle';
    if (!child) return Promise.resolve();
    return terminateProcessTree(child);
  }

  /** Detaches the turn (timer, abort listener) without settling it. */
  private releaseTurn(active: CopilotActiveTurn): void {
    if (active.timer) clearTimeout(active.timer);
    if (active.signal && active.onAbort) active.signal.removeEventListener('abort', active.onAbort);
    if (this.active === active) this.active = undefined;
  }
}
