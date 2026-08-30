import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  RemoteBinding,
  RemoteExecutionState,
  RemoteOutboxRecord,
  RemoteRequestRecord,
} from './types';
import {
  EMPTY_REMOTE_STATE,
  LegacyRemoteStateSchema,
  MAX_OUTBOX_RECORDS,
  MAX_RECORDS,
  RemoteStateSchema,
  RETENTION_MS,
  type RemoteSelection,
  type RemoteStoreState,
} from './RemoteStoreSchemas';

export function remoteDedupKey(channel: string, chatId: string, messageId: string): string {
  return `${channel}\u0000${chatId}\u0000${messageId}`;
}

/** Versioned global-storage state with one serialized atomic mutation owner. */
export class RemoteRequestStore {
  private state: RemoteStoreState = structuredClone(EMPTY_REMOTE_STATE);
  private mutationTail: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly legacyFilePath?: string,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = RemoteStateSchema.parse(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
      this.state = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await this.importLegacyOrCreate();
    }
    await this.mutate((draft) => {
      const now = Date.now();
      for (const request of draft.requests) {
        if (request.state === 'running') {
          request.state = 'unknown';
          request.updatedAt = now;
        }
      }
      for (const item of draft.outbox) {
        if (item.state === 'sending') item.state = 'pending';
      }
      for (const receipt of draft.controlReceipts) {
        if (receipt.state === 'pending') receipt.state = 'unknown';
      }
    });
    this.loaded = true;
  }

  getByDedupKey(key: string): RemoteRequestRecord | undefined {
    return this.state.requests.find((request) => request.dedupKey === key);
  }

  getRequest(id: string): RemoteRequestRecord | undefined {
    return this.state.requests.find((request) => request.id === id);
  }

  queued(conversationId?: string, channel?: RemoteRequestRecord['channel']): RemoteRequestRecord[] {
    return this.state.requests
      .filter(
        (request) =>
          request.state === 'queued' &&
          (conversationId === undefined || request.conversationId === conversationId) &&
          (channel === undefined || request.channel === channel),
      )
      .sort((a, b) => (a.admittedAt ?? a.receivedAt) - (b.admittedAt ?? b.receivedAt));
  }

  pendingOutbox(channel?: RemoteOutboxRecord['channel']): RemoteOutboxRecord[] {
    return this.state.outbox.filter(
      (item) => item.state === 'pending' && (channel === undefined || item.channel === channel),
    );
  }

  outboxHealth(): { pending: number; sending: number; abandoned: number } {
    return {
      pending: this.state.outbox.filter((item) => item.state === 'pending').length,
      sending: this.state.outbox.filter((item) => item.state === 'sending').length,
      abandoned: this.state.outbox.filter((item) => item.state === 'abandoned').length,
    };
  }

  requestHealth(): { queued: number; running: number; unknown: number } {
    return {
      queued: this.state.requests.filter((item) => item.state === 'queued').length,
      running: this.state.requests.filter((item) => item.state === 'running').length,
      unknown: this.state.requests.filter((item) => item.state === 'unknown').length,
    };
  }

  binding(channel: string, chatId: string): RemoteBinding | undefined {
    return this.state.bindings.find((item) => item.channel === channel && item.chatId === chatId);
  }

  async setBinding(binding: RemoteBinding): Promise<void> {
    await this.mutate((draft) => {
      draft.bindings = draft.bindings.filter(
        (item) => item.channel !== binding.channel || item.chatId !== binding.chatId,
      );
      draft.bindings.push(binding);
    });
  }

  async issueSelection(
    channel: RemoteBinding['channel'],
    chatId: string,
    kind: RemoteSelection['kind'],
    values: string[],
    ttlMs: number,
  ): Promise<void> {
    const issuedAt = Date.now();
    await this.mutate((draft) => {
      draft.selections = draft.selections.filter(
        (item) => item.channel !== channel || item.chatId !== chatId || item.kind !== kind,
      );
      draft.selections.push({
        channel,
        chatId,
        kind,
        values,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
      });
    });
  }

  selection(
    channel: RemoteBinding['channel'],
    chatId: string,
    kind: RemoteSelection['kind'],
  ): RemoteSelection | undefined {
    const item = this.state.selections.find(
      (candidate) =>
        candidate.channel === channel && candidate.chatId === chatId && candidate.kind === kind,
    );
    return item && item.expiresAt > Date.now() ? structuredClone(item) : undefined;
  }

  async enqueue(record: RemoteRequestRecord): Promise<boolean> {
    let inserted = false;
    await this.mutate((draft) => {
      if (draft.requests.some((item) => item.dedupKey === record.dedupKey)) return;
      draft.requests.push(record);
      inserted = true;
      if (draft.requests.length > MAX_RECORDS) {
        const removable = draft.requests.filter((item) =>
          ['completed', 'failed', 'cancelled', 'unknown'].includes(item.state),
        );
        for (const old of removable.slice(0, draft.requests.length - MAX_RECORDS)) {
          draft.requests = draft.requests.filter((item) => item.id !== old.id);
        }
      }
    });
    return inserted;
  }

  async markRunning(id: string): Promise<void> {
    await this.setRequestState(id, 'running');
  }

  async claimNext(
    conversationId: string,
    channel: RemoteRequestRecord['channel'],
  ): Promise<RemoteRequestRecord | undefined> {
    let claimedId: string | undefined;
    await this.mutate((draft) => {
      if (
        draft.requests.some(
          (item) => item.conversationId === conversationId && item.state === 'running',
        )
      ) {
        return;
      }
      const next = draft.requests
        .filter((item) => item.conversationId === conversationId && item.state === 'queued')
        .sort((a, b) => (a.admittedAt ?? a.receivedAt) - (b.admittedAt ?? b.receivedAt))[0];
      if (!next || next.channel !== channel) return;
      next.state = 'running';
      next.updatedAt = Date.now();
      claimedId = next.id;
    });
    return claimedId ? this.getRequest(claimedId) : undefined;
  }

  async requeue(id: string): Promise<void> {
    await this.setRequestState(id, 'queued');
  }

  async finish(
    id: string,
    state: Extract<RemoteExecutionState, 'completed' | 'failed' | 'cancelled'>,
    payload: {
      finalText?: string;
      error?: string;
      notification: string;
      announceConversationId?: string;
    },
  ): Promise<void> {
    await this.mutate((draft) => {
      const request = draft.requests.find((item) => item.id === id);
      if (!request) throw new Error(`Forge: remote request ${id} is missing.`);
      request.state = state;
      request.updatedAt = Date.now();
      if (payload.finalText) request.finalText = payload.finalText;
      if (payload.error) request.error = payload.error;
      draft.outbox.push({
        id: randomUUID(),
        requestId: request.id,
        channel: request.channel,
        chatId: request.chatId,
        text: payload.notification,
        state: 'pending',
        attempts: 0,
        updatedAt: Date.now(),
      });
      if (payload.announceConversationId) {
        const binding = draft.bindings.find(
          (item) => item.channel === request.channel && item.chatId === request.chatId,
        );
        if (binding && binding.conversationId === payload.announceConversationId) {
          binding.announcedConversationId = payload.announceConversationId;
        }
      }
    });
  }

  async markOutbox(id: string, state: RemoteOutboxRecord['state']): Promise<void> {
    await this.mutate((draft) => {
      const item = draft.outbox.find((candidate) => candidate.id === id);
      if (!item) return;
      item.state = state;
      item.updatedAt = Date.now();
      if (state === 'sending') item.attempts += 1;
    });
  }

  async setCursor(key: string, value: string): Promise<void> {
    await this.mutate((draft) => {
      draft.cursors[key] = value;
    });
  }

  cursor(key: string): string | undefined {
    return this.state.cursors[key];
  }

  async beginControlEvent(dedupKey: string): Promise<'admitted' | 'completed' | 'unknown'> {
    let result: 'admitted' | 'completed' | 'unknown' = 'admitted';
    await this.mutate((draft) => {
      const existing = draft.controlReceipts.find((item) => item.dedupKey === dedupKey);
      if (existing) {
        result = existing.state === 'completed' ? 'completed' : 'unknown';
        return;
      }
      draft.controlReceipts.push({ dedupKey, state: 'pending', updatedAt: Date.now() });
    });
    return result;
  }

  async finishControlEvent(dedupKey: string): Promise<void> {
    await this.mutate((draft) => {
      const receipt = draft.controlReceipts.find((item) => item.dedupKey === dedupKey);
      if (!receipt) throw new Error('Forge remote control receipt is missing.');
      receipt.state = 'completed';
      receipt.updatedAt = Date.now();
    });
  }

  async discardControlEvent(dedupKey: string): Promise<void> {
    await this.mutate((draft) => {
      draft.controlReceipts = draft.controlReceipts.filter((item) => item.dedupKey !== dedupKey);
    });
  }

  private async setRequestState(id: string, state: RemoteExecutionState): Promise<void> {
    await this.mutate((draft) => {
      const request = draft.requests.find((item) => item.id === id);
      if (!request) throw new Error(`Forge: remote request ${id} is missing.`);
      request.state = state;
      request.updatedAt = Date.now();
    });
  }

  private mutate(mutator: (draft: RemoteStoreState) => void): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const draft = structuredClone(this.state);
      mutator(draft);
      const cutoff = Date.now() - RETENTION_MS;
      draft.requests = draft.requests.filter(
        (item) => item.updatedAt >= cutoff || item.state === 'queued' || item.state === 'running',
      );
      draft.outbox = draft.outbox
        .filter(
          (item) =>
            item.updatedAt >= cutoff || item.state === 'pending' || item.state === 'sending',
        )
        .slice(-MAX_OUTBOX_RECORDS);
      draft.controlReceipts = draft.controlReceipts
        .filter((item) => item.updatedAt >= cutoff || item.state === 'pending')
        .slice(-MAX_RECORDS);
      draft.selections = draft.selections.filter((item) => item.expiresAt >= Date.now());
      RemoteStateSchema.parse(draft);
      await this.persist(draft);
      this.state = draft;
    });
    this.mutationTail = operation.catch(() => undefined);
    return operation;
  }

  private async importLegacyOrCreate(): Promise<void> {
    if (!this.legacyFilePath) {
      await this.persist(this.state);
      return;
    }
    try {
      const legacy = LegacyRemoteStateSchema.parse(
        JSON.parse(await fs.readFile(this.legacyFilePath, 'utf8')),
      );
      this.state = {
        version: 2,
        requests: legacy.requests,
        outbox: legacy.outbox,
        bindings: legacy.bindings,
        cursors: legacy.cursors,
        controlReceipts: legacy.controlReceipts,
        selections: [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await this.persist(this.state);
  }

  private async persist(state: RemoteStoreState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
}
