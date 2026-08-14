import * as readline from 'readline';
import { spawnCliProcess, terminateCliProcessTree, waitForCliProcessExit } from './cliProcess';
import type {
  CliAgentSessionOptions,
  CliAgentSessionSendOptions,
  CliAgentSessionState,
} from './CliAgentSession';
import type { CliAgentRunResult } from './types';

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ActiveTurn {
  text: string;
  /** Text already received per app-server agent-message item. */
  readonly agentMessageText: Map<string, string>;
  sawCommandExecution: boolean;
  turnId?: string;
  interrupted: boolean;
  interruptSent: boolean;
  resolve(result: CliAgentRunResult): void;
  signal?: AbortSignal;
  onAbort(): void;
  onEvent?: CliAgentSessionSendOptions['onEvent'];
}

/** Warm Codex `app-server --stdio` JSON-RPC session. */
export class CodexAppServerSession {
  private currentState: CliAgentSessionState = 'starting';
  private child: ReturnType<typeof spawnCliProcess> | undefined;
  private input: readline.Interface | undefined;
  private active: ActiveTurn | undefined;
  private threadId: string | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
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
      args: [
        ...(this.options.argsPrefix ?? []),
        'app-server',
        '--stdio',
        '-c',
        'analytics.enabled=false',
        // Apply the policy to the Forge-owned app-server process as well as the
        // thread. This prevents a persisted local Codex setting from causing a
        // resumed warm session to enter the Windows sandbox.
        '-c',
        'sandbox_mode="danger-full-access"',
      ],
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
      const result = await this.request('thread/start', {
        cwd: this.options.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: false,
        ...(this.options.model ? { model: this.options.model } : {}),
      });
      this.threadId = this.validateThreadResult(result, 'thread/start');
    }
    this.currentState = 'idle';
  }

  private request(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
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
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) void this.failProtocol(`Codex app-server write failed: ${error.message}`);
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      void this.failProtocol('Codex app-server emitted malformed JSON.');
      return;
    }
    if (!message || typeof message !== 'object') {
      void this.failProtocol('Codex app-server emitted a non-object message.');
      return;
    }
    const value = message as Record<string, unknown>;
    if (typeof value['id'] === 'number') {
      this.handleResponse(value['id'], value);
      return;
    }
    if (typeof value['method'] === 'string') {
      this.handleNotification(value['method'], value['params']);
      return;
    }
    void this.failProtocol('Codex app-server emitted an uncorrelated message.');
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) {
      void this.failProtocol(`Codex app-server response ${id} has no matching request.`);
      return;
    }
    this.pending.delete(id);
    if (message['error']) {
      pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message['error'])}`));
    } else {
      pending.resolve(message['result']);
    }
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
      this.appendAgentText(
        active,
        typeof itemId === 'string' ? itemId : undefined,
        params['delta'],
      );
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
      this.captureCompletedAgentMessage(active, params);
      return;
    }
    if (method === 'turn/completed') void this.finishFromTerminal(params);
  }

  private appendAgentText(active: ActiveTurn, itemId: string | undefined, text: string): void {
    if (!text) return;
    active.text += text;
    if (itemId) {
      active.agentMessageText.set(itemId, `${active.agentMessageText.get(itemId) ?? ''}${text}`);
    }
    active.onEvent?.({ kind: 'text', text });
  }

  /**
   * Recent Codex app-server versions may deliver an assistant's final message
   * only in item/completed, after the command item. Capture its unstreamed
   * suffix without duplicating text that arrived through delta notifications.
   */
  private captureCompletedAgentMessage(active: ActiveTurn, params: Record<string, unknown>): void {
    const item = params['item'];
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
    if (!record) return;
    this.captureAgentMessage(active, record);
  }

  private captureAgentMessage(active: ActiveTurn, record: Record<string, unknown>): void {
    if (record['type'] !== 'agentMessage' || typeof record['text'] !== 'string') return;
    const itemId = typeof record['id'] === 'string' ? record['id'] : undefined;
    const completed = record['text'];
    const streamed = itemId ? active.agentMessageText.get(itemId) : undefined;
    if (streamed !== undefined && completed.startsWith(streamed)) {
      this.appendAgentText(active, itemId, completed.slice(streamed.length));
      return;
    }
    // Some app-server builds omit or change the delta's item id. Do not treat
    // an empty per-item buffer as a full-prefix match: completed.startsWith('')
    // is always true and would append the already streamed reply a second time.
    if (active.text.includes(completed)) return;
    const overlap = trailingPrefixOverlap(active.text, completed);
    this.appendAgentText(active, itemId, completed.slice(overlap));
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
        this.captureTerminalTurnMessages(active, result);
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

  /**
   * Some app-server builds omit item/completed for the final message after a
   * command. The completed turn history is the authoritative fallback.
   */
  private captureTerminalTurnMessages(active: ActiveTurn, result: unknown): void {
    const root =
      result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
    const thread = root?.['thread'];
    const threadRecord =
      thread && typeof thread === 'object' ? (thread as Record<string, unknown>) : undefined;
    const turns = threadRecord?.['turns'];
    if (!Array.isArray(turns)) return;
    const turn = turns.find(
      (value) =>
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>)['id'] === active.turnId,
    ) as Record<string, unknown> | undefined;
    const items = turn?.['items'];
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      this.captureAgentMessage(active, item as Record<string, unknown>);
    }
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
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
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

/** Length of the longest suffix of `existing` that is a prefix of `next`. */
function trailingPrefixOverlap(existing: string, next: string): number {
  const limit = Math.min(existing.length, next.length);
  for (let length = limit; length > 0; length -= 1) {
    if (existing.endsWith(next.slice(0, length))) return length;
  }
  return 0;
}
