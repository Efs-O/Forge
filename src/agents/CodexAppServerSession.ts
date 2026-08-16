import * as readline from 'readline';
import { spawnCliProcess, terminateCliProcessTree, waitForCliProcessExit } from './cliProcess';
import { decideCodexApproval } from './CodexApprovalPolicy';
import type {
  CliAgentSessionOptions,
  CliAgentSessionSendOptions,
  CliAgentSessionState,
} from './CliAgentSession';
import type { CliAgentRunResult } from './types';
import { JsonRpcPending, routeJsonRpcLine } from './jsonRpcStdio';
import { codexAppServerArgs, codexThreadStartParams } from './codexAppServerArgs';
import {
  appendAgentText,
  captureCompletedAgentMessage,
  captureTerminalTurnMessages,
  type ActiveTurn,
} from './codexTurnText';

/** Warm Codex `app-server --stdio` JSON-RPC session. */
export class CodexAppServerSession {
  private currentState: CliAgentSessionState = 'starting';
  private child: ReturnType<typeof spawnCliProcess> | undefined;
  private input: readline.Interface | undefined;
  private active: ActiveTurn | undefined;
  private threadId: string | undefined;
  private readonly pending = new JsonRpcPending();
  private startPromise: Promise<void> | undefined;

  constructor(private readonly options: CliAgentSessionOptions) {
    this.threadId = options.confirmedSessionId;
  }

  get state(): CliAgentSessionState {
    return this.currentState;
  }

  get confirmedSessionId(): string | undefined {
    return this.threadId;
  }

  async send(task: string, options: CliAgentSessionSendOptions = {}): Promise<CliAgentRunResult> {
    if (this.currentState === 'disposed') throw new Error('CLI agent session is disposed.');
    if (this.active) throw new Error('CLI agent session already has an active turn.');
    await this.ensureStarted();
    this.currentState = 'running';
    return new Promise<CliAgentRunResult>((resolve) => {
      const onAbort = (): void => {
        if (!this.active) return;
        this.active.interrupted = true;
        this.sendInterrupt(this.active);
      };
      const active: ActiveTurn = {
        text: '',
        agentMessageText: new Map(),
        sawCommandExecution: false,
        interrupted: false,
        interruptSent: false,
        resolve,
        ...(options.signal ? { signal: options.signal } : {}),
        onAbort,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      };
      this.active = active;
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      void this.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: task, text_elements: [] }],
      })
        .then((result) => {
          if (this.active === active) this.captureTurnId(result);
        })
        .catch((error) => this.failProtocol(error.message));
    });
  }

  async dispose(): Promise<void> {
    if (this.currentState === 'disposed') return;
    this.currentState = 'disposed';
    await this.stop('CLI agent session disposed.');
  }

  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start();
    await this.startPromise;
  }

  private async start(): Promise<void> {
    const child = spawnCliProcess({
      executable: this.options.executable,
      args: codexAppServerArgs(this.options),
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
          ? `Codex app-server transport failed: ${exit.error.message}`
          : `Codex app-server exited with code ${exit.code ?? '?'}.`,
      );
    });
    await this.request('initialize', {
      clientInfo: { name: 'forge', title: 'Forge', version: '1' },
      capabilities: null,
    });
    this.notify('initialized');
    if (this.threadId) {
      const result = await this.request('thread/resume', { threadId: this.threadId });
      this.validateThreadResult(result, 'thread/resume');
    } else {
      const result = await this.request(
        'thread/start',
        codexThreadStartParams(this.options.cwd, this.options.model),
      );
      this.threadId = this.validateThreadResult(result, 'thread/start');
    }
    this.currentState = 'idle';
  }

  private request(method: string, params: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.pending.open(method, resolve, reject);
      this.write({ id, method, params });
    });
  }

  private notify(method: string): void {
    this.write({ method });
  }

  private write(message: object): void {
    if (!this.child?.stdin?.writable) {
      void this.failProtocol('Codex app-server stdin is unavailable.');
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify(message)}
`,
      (error) => {
        if (error) void this.failProtocol(`Codex app-server write failed: ${error.message}`);
      },
    );
  }

  private handleLine(line: string): void {
    routeJsonRpcLine(line, this.pending, {
      onRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onNotification: (method, params) => this.handleNotification(method, params),
      onProtocolError: (message) => void this.failProtocol(message),
    });
  }

  /**
   * Codex app-server sends approval elicitations as server-initiated JSON-RPC
   * requests. Forge answers them automatically: ordinary workspace work keeps
   * moving, while destructive commands and all sandbox-expansion requests are
   * denied. This is intentionally enforcement, not a stream of modal prompts.
   */
  private handleServerRequest(id: number, method: string, rawParams: unknown): void {
    const params =
      rawParams && typeof rawParams === 'object'
        ? (rawParams as Record<string, unknown>)
        : undefined;
    const active = this.active;
    if (!params || !active || params['threadId'] !== this.threadId) {
      void this.failProtocol(`Codex ${method} did not match the active thread.`);
      return;
    }

    const approval = decideCodexApproval(method, params);
    active.onEvent?.({ kind: 'status', text: `[codex policy: ${approval.status}]` });
    this.write({ id, result: { decision: approval.decision } });
  }

  private handleNotification(method: string, rawParams: unknown): void {
    if (!method.startsWith('turn/') && !method.startsWith('item/')) return;
    const params =
      rawParams && typeof rawParams === 'object'
        ? (rawParams as Record<string, unknown>)
        : undefined;
    const active = this.active;
    if (!params || !active || params['threadId'] !== this.threadId) {
      void this.failProtocol(`Codex ${method} did not match the active thread.`);
      return;
    }
    if (method === 'turn/started') {
      const turn = params['turn'];
      const id =
        turn && typeof turn === 'object' ? (turn as Record<string, unknown>)['id'] : undefined;
      if (typeof id !== 'string') {
        void this.failProtocol('Codex turn/started returned no turn id.');
        return;
      }
      this.setTurnId(id);
      return;
    }
    const eventTurnId = params['turnId'];
    if (typeof eventTurnId === 'string' && active.turnId && eventTurnId !== active.turnId) {
      void this.failProtocol(`Codex ${method} did not match the active turn.`);
      return;
    }
    if (method === 'item/agentMessage/delta') {
      if (typeof params['delta'] !== 'string') {
        void this.failProtocol('Codex agent-message delta had no text.');
        return;
      }
      const itemId = params['itemId'];
      appendAgentText(active, typeof itemId === 'string' ? itemId : undefined, params['delta']);
      return;
    }
    if (method === 'item/started') {
      const item = params['item'];
      const type =
        item && typeof item === 'object' ? (item as Record<string, unknown>)['type'] : undefined;
      if (type === 'commandExecution') active.sawCommandExecution = true;
      active.onEvent?.({ kind: 'status', text: `[codex: ${String(type ?? 'item')}]` });
      return;
    }
    if (method === 'item/completed') {
      captureCompletedAgentMessage(active, params);
      return;
    }
    if (method === 'turn/completed') void this.finishFromTerminal(params);
  }

  private captureTurnId(result: unknown): void {
    if (!result || typeof result !== 'object') return;
    const turn = (result as Record<string, unknown>)['turn'];
    const id =
      turn && typeof turn === 'object' ? (turn as Record<string, unknown>)['id'] : undefined;
    if (typeof id === 'string') this.setTurnId(id);
  }

  private setTurnId(id: string): void {
    const active = this.active;
    if (!active) return;
    if (active.turnId && active.turnId !== id) {
      void this.failProtocol('Codex returned mismatched turn ids.');
      return;
    }
    active.turnId = id;
    if (active.interrupted) this.sendInterrupt(active);
  }

  private sendInterrupt(active: ActiveTurn): void {
    if (!active.turnId || active.interruptSent) return;
    active.interruptSent = true;
    void this.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: active.turnId,
    }).catch((error) => this.failProtocol(error.message));
  }

  private async finishFromTerminal(params: Record<string, unknown>): Promise<void> {
    const turn = params['turn'];
    const record = turn && typeof turn === 'object' ? (turn as Record<string, unknown>) : undefined;
    const id = record?.['id'];
    const status = record?.['status'];
    if (typeof id !== 'string' || id !== this.active?.turnId || typeof status !== 'string') {
      void this.failProtocol('Codex terminal event did not match the active turn.');
      return;
    }
    const active = this.active;
    if (active.sawCommandExecution && this.threadId) {
      try {
        const result = await this.request('thread/read', {
          threadId: this.threadId,
          includeTurns: true,
        });
        captureTerminalTurnMessages(active, result);
      } catch {
        // The streamed response remains usable if the optional history read fails.
      }
    }
    if (this.active !== active) return;
    this.clearActive(active);
    this.currentState = 'idle';
    active.resolve({
      status:
        status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed',
      finalText: active.text,
      ...(status !== 'completed'
        ? { error: status === 'interrupted' ? 'Cancelled.' : `Codex turn ${status}.` }
        : {}),
      ...(this.threadId ? { sessionId: this.threadId } : {}),
    });
  }

  private validateThreadResult(result: unknown, method: string): string {
    const value =
      result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
    const thread = value?.['thread'];
    const id =
      thread && typeof thread === 'object' ? (thread as Record<string, unknown>)['id'] : undefined;
    if (typeof id !== 'string' || (this.threadId && id !== this.threadId)) {
      throw new Error(`Codex ${method} returned a mismatched thread id.`);
    }
    return id;
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
    this.pending.rejectAll(new Error(message));
    const active = this.active;
    if (active) {
      this.clearActive(active);
      active.resolve({
        status: 'failed',
        finalText: active.text,
        error: message,
        ...(this.threadId ? { sessionId: this.threadId } : {}),
      });
    }
    if (child) await terminateCliProcessTree(child);
    if (this.currentState !== 'disposed') this.currentState = 'idle';
  }

  private clearActive(active: ActiveTurn): void {
    active.signal?.removeEventListener('abort', active.onAbort);
    if (this.active === active) this.active = undefined;
  }
}
