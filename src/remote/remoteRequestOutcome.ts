/**
 * What a finished remote turn becomes in the durable draft: the request row's
 * terminal state, the reply that must be delivered, and the one-way announce
 * flag on the binding that has already been told.
 *
 * Split from `RemoteRequestStore` on the same seam as `remoteQueueOrdering`
 * and `RemoteHandoffState`: a pure function over the locked draft, so the
 * store keeps sole ownership of loading, serializing and persisting state
 * while these decide what a record becomes.
 */

import { randomUUID } from 'crypto';
import type { RemoteExecutionState, RemoteOutboxRecord } from './types';
import type { RemoteStoreState } from './RemoteStoreSchemas';

export type RemoteRequestFinishPayload = {
  finalText?: string;
  error?: string;
  notification: string;
  announceConversationId?: string;
  /** Deleted from the chat after the command-reply delay, like a transient reply. */
  ephemeral?: boolean;
  /** This turn's speed line; see `OutboxSchema`. It is never part of `text`. */
  speedLine?: string;
  telegramReply?: RemoteOutboxRecord['telegramReply'];
};

/**
 * Finish one remote request in the store's locked draft: settle its row, push
 * the reply the chat has to see, and mark the binding that was told. Throws
 * when the row is gone — the caller had it, so its absence is a bug, not a
 * race another window could win.
 */
export function finishRequestInDraft(
  draft: RemoteStoreState,
  id: string,
  state: Extract<RemoteExecutionState, 'completed' | 'failed' | 'cancelled'>,
  payload: RemoteRequestFinishPayload,
): void {
  const request = draft.requests.find((item) => item.id === id);
  if (!request) throw new Error(`Forge: remote request ${id} is missing.`);
  request.state = state;
  delete request.claimOwner;
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
    ...(payload.ephemeral ? { ephemeral: true } : {}),
    ...(payload.speedLine ? { speedLine: payload.speedLine } : {}),
    ...(payload.telegramReply ? { telegramReply: payload.telegramReply } : {}),
  });
  if (payload.announceConversationId) {
    const binding = draft.bindings.find(
      (item) => item.channel === request.channel && item.chatId === request.chatId,
    );
    if (binding && binding.conversationId === payload.announceConversationId) {
      binding.announcedConversationId = payload.announceConversationId;
    }
  }
}
