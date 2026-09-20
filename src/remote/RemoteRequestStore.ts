import * as fs from 'fs/promises';
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
  migrateLegacyState,
  RemoteStateSchema,
  RETENTION_MS,
  type RemoteSelection,
  type RemoteStoreState,
  type WorkspaceHandoff,
} from './RemoteStoreSchemas';
import { bindingsForConversation, bindingsForWorkspace } from './remoteBindingQueries';
import { writeRemoteStateFile } from './remoteStateFile';
import {
  claimHandoffs,
  completeHandoff,
  failUnclaimedHandoff,
  hasPendingHandoff,
  replaceHandoffForChat,
  type HandoffInput,
} from './RemoteHandoffState';
import {
  cancelQueuedInDraft,
  claimNextInDraft,
  compareQueuedRequests,
  promoteQueuedInDraft,
} from './remoteQueueOrdering';
import {
  findSelection,
  newSelectionToken,
  removeSelection,
  replaceSelection,
} from './RemoteSelectionState';
import { pruneContactState } from './RemoteContactRetention';

export function remoteDedupKey(channel: string, chatId: string, messageId: string): string {
  return `${channel}\u0000${chatId}\u0000${messageId}`;
}

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
      this.state = RemoteStateSchema.parse(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
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
  contactRead<T>(reader: (state: RemoteStoreState) => T): T {
    return reader(this.state);
  }

  contactMutate<T>(mutator: (draft: RemoteStoreState) => T, reloadFirst = true): Promise<T> {
    let result!: T;
    return this.mutate((draft) => (result = mutator(draft)), reloadFirst).then(() => result);
  }

  queued(conversationId?: string, channel?: RemoteRequestRecord['channel']): RemoteRequestRecord[] {
    return this.state.requests
      .filter(
        (request) =>
          request.state === 'queued' &&
          (conversationId === undefined || request.conversationId === conversationId) &&
          (channel === undefined || request.channel === channel),
      )
      .sort(compareQueuedRequests);
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

  /**
   * Per-conversation health (AGENT_MESH_PLAN §5, P1): the calling chat's
   * counts, not the global total. Legacy records without conversation
   * metadata are excluded (`unknown-scope`); `unknown` stays `unknown`.
   */
  requestHealthForConversation(conversationId: string) {
    const count = (state: string) =>
      this.state.requests.filter(
        (item) =>
          typeof item.conversationId === 'string' &&
          item.conversationId.length > 0 &&
          item.conversationId === conversationId &&
          item.state === state,
      ).length;
    return { queued: count('queued'), running: count('running'), unknown: count('unknown') };
  }

  binding(channel: string, chatId: string): RemoteBinding | undefined {
    return this.state.bindings.find((item) => item.channel === channel && item.chatId === chatId);
  }

  /** Reverse of `binding()`. See remoteBindingQueries for both selectors. */
  bindingsForConversation(
    conversationId: string,
    channel?: RemoteBinding['channel'],
  ): RemoteBinding[] {
    return bindingsForConversation(this.state.bindings, conversationId, channel);
  }

  /** Every chat bound to this workspace, whatever conversation each is on. */
  bindingsForWorkspace(workspaceId: string, channel?: RemoteBinding['channel']): RemoteBinding[] {
    return bindingsForWorkspace(this.state.bindings, workspaceId, channel);
  }

  /**
   * Enqueue a host-originated notification that has no backing request (e.g. a
   * compaction progress line). Durable write only — it does NOT wake the
   * delivery loop; the caller (RemoteController) must kick delivery after this.
   */
  async notifyOutbox(
    channel: RemoteOutboxRecord['channel'],
    chatId: string,
    text: string,
  ): Promise<void> {
    await this.mutate((draft) => {
      draft.outbox.push({
        id: randomUUID(),
        requestId: `host-${randomUUID()}`,
        channel,
        chatId,
        text,
        state: 'pending',
        attempts: 0,
        updatedAt: Date.now(),
      });
    });
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
  ): Promise<string> {
    const issuedAt = Date.now();
    const token = newSelectionToken();
    await this.mutate((draft) => {
      draft.selections = replaceSelection(draft.selections, {
        channel,
        chatId,
        kind,
        token,
        values,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
      });
    });
    return token;
  }

  selection(
    channel: RemoteBinding['channel'],
    chatId: string,
    kind: RemoteSelection['kind'],
    token?: string,
  ): RemoteSelection | undefined {
    const item = findSelection(this.state.selections, { channel, chatId, kind }, token, Date.now());
    return item && structuredClone(item);
  }

  async clearSelection(
    channel: RemoteBinding['channel'],
    chatId: string,
    kind: RemoteSelection['kind'],
    token: string,
  ): Promise<boolean> {
    let removed = false;
    await this.mutate((draft) => {
      const result = removeSelection(draft.selections, { channel, chatId, kind }, token);
      draft.selections = result.selections;
      removed = result.removed;
    });
    return removed;
  }

  /** Returns the id so the source window can later ask who claimed it. */
  async beginWorkspaceHandoff(handoff: HandoffInput): Promise<string> {
    const id = randomUUID();
    await this.mutate((draft) => {
      const list = draft.workspaceHandoffs;
      draft.workspaceHandoffs = replaceHandoffForChat(list, handoff, Date.now(), id);
    });
    return id;
  }

  /** Written by another window, so callers `refresh()` first. */
  hasPendingWorkspaceHandoff(workspaceId: string): boolean {
    return hasPendingHandoff(this.state.workspaceHandoffs, workspaceId, Date.now());
  }

  /** Rereads first: two windows on one folder must not both claim. */
  async claimWorkspaceHandoffs(workspaceId: string): Promise<WorkspaceHandoff[]> {
    let claimed: WorkspaceHandoff[] = [];
    await this.mutate((draft) => {
      claimed = claimHandoffs(draft.workspaceHandoffs, workspaceId, Date.now());
    }, true);
    return claimed;
  }

  async completeWorkspaceHandoff(id: string): Promise<void> {
    await this.mutate((draft) => completeHandoff(draft.workspaceHandoffs, id, Date.now()));
  }

  /** The source window undoing a switch whose target never came up. Rereads
   *  inside the mutation, so a claim already on disk wins. */
  async failUnclaimedWorkspaceHandoff(id: string): Promise<'failed' | 'claimed' | 'gone'> {
    let outcome: 'failed' | 'claimed' | 'gone' = 'gone';
    await this.mutate((draft) => {
      outcome = failUnclaimedHandoff(draft.workspaceHandoffs, id, Date.now());
    }, true);
    return outcome;
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
      claimedId = claimNextInDraft(draft.requests, conversationId, channel);
    });
    return claimedId ? this.getRequest(claimedId) : undefined;
  }

  async requeue(id: string): Promise<void> {
    await this.setRequestState(id, 'queued');
  }

  /** `/steer <n>`: run an already-queued prompt next. */
  async promoteQueued(conversationId: string, requestId: string): Promise<boolean> {
    let promoted = false;
    await this.mutate((draft) => {
      promoted = promoteQueuedInDraft(draft.requests, conversationId, requestId);
    });
    return promoted;
  }

  /** `/drop`: cancel queued prompts without deleting their audit record. */
  async cancelQueued(conversationId: string, requestIds?: ReadonlySet<string>): Promise<number> {
    let cancelled = 0;
    await this.mutate((draft) => {
      cancelled = cancelQueuedInDraft(draft.requests, conversationId, requestIds);
    });
    return cancelled;
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

  async refresh(): Promise<void> {
    const operation = this.mutationTail.then(() => this.reload());
    this.mutationTail = operation.catch(() => undefined);
    return operation;
  }

  private async reload(): Promise<void> {
    try {
      this.state = RemoteStateSchema.parse(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private mutate(mutator: (draft: RemoteStoreState) => void, reloadFirst = false): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      if (reloadFirst) await this.reload();
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
      draft.workspaceHandoffs = draft.workspaceHandoffs.filter(
        (item) => item.expiresAt >= Date.now(),
      );
      pruneContactState(draft, cutoff, Date.now());
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
      this.state = migrateLegacyState(
        LegacyRemoteStateSchema.parse(JSON.parse(await fs.readFile(this.legacyFilePath, 'utf8'))),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await this.persist(this.state);
  }

  private persist(state: RemoteStoreState): Promise<void> {
    return writeRemoteStateFile(this.filePath, JSON.stringify(state));
  }
}
