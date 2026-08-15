import {
  CliAgentSession,
  type CliAgentSessionOptions,
  type CliAgentSessionSendOptions,
} from './CliAgentSession';
import type { CliAgentRunResult } from './types';
import { CodexAppServerSession } from './CodexAppServerSession';

interface RegistryEntry {
  session: WarmCliSession;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface CliSessionKey {
  conversationId: string;
  modelName: string;
}

export interface WarmCliSession {
  readonly state: CliAgentSession['state'];
  readonly confirmedSessionId: string | undefined;
  send(task: string, options?: CliAgentSessionSendOptions): Promise<CliAgentRunResult>;
  dispose(): Promise<void>;
}

export type CliSessionFactory = (options: CliAgentSessionOptions) => WarmCliSession;

export const DEFAULT_MAX_CLI_AGENTS = 4;
export const DEFAULT_CLI_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export class CliSessionCapacityError extends Error {
  constructor(maxSessions: number) {
    super(`Forge CLI agent capacity (${maxSessions}) is full and every session is busy.`);
    this.name = 'CliSessionCapacityError';
  }
}

/** Owns warm CLI processes by the exact (conversation, model) pair. */
export class CliSessionRegistry {
  private readonly conversations = new Map<string, Map<string, RegistryEntry>>();
  private sequence = 0;

  constructor(
    private readonly maxSessions: number,
    private readonly idleTimeoutMs: number,
    private readonly factory: CliSessionFactory = (options) =>
      options.cliName === 'codex'
        ? new CodexAppServerSession(options)
        : new CliAgentSession(options),
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new Error('maxSessions must be a positive integer.');
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1) {
      throw new Error('idleTimeoutMs must be positive.');
    }
  }

  async run(
    key: CliSessionKey,
    sessionOptions: CliAgentSessionOptions,
    task: string,
    sendOptions: CliAgentSessionSendOptions = {},
  ): Promise<CliAgentRunResult> {
    const entry = await this.getOrCreate(key, sessionOptions);
    this.clearIdleTimer(entry);
    entry.lastUsed = ++this.sequence;
    try {
      return await entry.session.send(task, sendOptions);
    } finally {
      entry.lastUsed = ++this.sequence;
      if (entry.session.state === 'idle') this.scheduleIdleDisposal(key, entry);
    }
  }

  getConfirmedSessionId(key: CliSessionKey): string | undefined {
    return this.getEntry(key)?.session.confirmedSessionId;
  }

  async disposeConversation(conversationId: string): Promise<void> {
    const models = this.conversations.get(conversationId);
    if (!models) return;
    this.conversations.delete(conversationId);
    await Promise.all([...models.values()].map((entry) => this.disposeEntry(entry)));
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries()].map(([, entry]) => entry);
    this.conversations.clear();
    await Promise.all(entries.map((entry) => this.disposeEntry(entry)));
  }

  private async getOrCreate(
    key: CliSessionKey,
    options: CliAgentSessionOptions,
  ): Promise<RegistryEntry> {
    const existing = this.getEntry(key);
    if (existing) return existing;
    if (this.size >= this.maxSessions) await this.evictLeastRecentlyUsedIdle();
    const entry: RegistryEntry = {
      session: this.factory(options),
      lastUsed: ++this.sequence,
      idleTimer: undefined,
    };
    let models = this.conversations.get(key.conversationId);
    if (!models) {
      models = new Map();
      this.conversations.set(key.conversationId, models);
    }
    models.set(key.modelName, entry);
    return entry;
  }

  private async evictLeastRecentlyUsedIdle(): Promise<void> {
    const candidates = [...this.entries()]
      .filter(([, entry]) => entry.session.state === 'idle')
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    const candidate = candidates[0];
    if (!candidate) throw new CliSessionCapacityError(this.maxSessions);
    this.removeEntry(candidate[0]);
    await this.disposeEntry(candidate[1]);
  }

  private scheduleIdleDisposal(key: CliSessionKey, entry: RegistryEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      if (entry.session.state !== 'idle' || this.getEntry(key) !== entry) return;
      this.removeEntry(key);
      void this.disposeEntry(entry);
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(entry: RegistryEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private async disposeEntry(entry: RegistryEntry): Promise<void> {
    this.clearIdleTimer(entry);
    await entry.session.dispose();
  }

  private getEntry(key: CliSessionKey): RegistryEntry | undefined {
    return this.conversations.get(key.conversationId)?.get(key.modelName);
  }

  private removeEntry(key: CliSessionKey): void {
    const models = this.conversations.get(key.conversationId);
    models?.delete(key.modelName);
    if (models?.size === 0) this.conversations.delete(key.conversationId);
  }

  private *entries(): IterableIterator<[CliSessionKey, RegistryEntry]> {
    for (const [conversationId, models] of this.conversations) {
      for (const [modelName, entry] of models) {
        yield [{ conversationId, modelName }, entry];
      }
    }
  }

  private get size(): number {
    let count = 0;
    for (const models of this.conversations.values()) count += models.size;
    return count;
  }
}
