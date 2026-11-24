import {
  MAX_OUTBOX_RECORDS,
  MAX_RECORDS,
  RETENTION_MS,
  type RemoteStoreState,
} from './RemoteStoreSchemas';
import { pruneContactState } from './RemoteContactRetention';

export function pruneRemoteState(draft: RemoteStoreState, now = Date.now()): void {
  const cutoff = now - RETENTION_MS;
  draft.requests = draft.requests.filter(
    (item) => item.updatedAt >= cutoff || item.state === 'queued' || item.state === 'running',
  );
  draft.sessionQuestions = draft.sessionQuestions.filter((item) => item.expiresAt >= now);
  draft.outbox = draft.outbox
    .filter(
      (item) => item.updatedAt >= cutoff || item.state === 'pending' || item.state === 'sending',
    )
    .slice(-MAX_OUTBOX_RECORDS);
  draft.controlReceipts = draft.controlReceipts
    .filter((item) => item.updatedAt >= cutoff || item.state === 'pending')
    .slice(-MAX_RECORDS);
  draft.selections = draft.selections.filter((item) => item.expiresAt >= now);
  draft.workspaceHandoffs = draft.workspaceHandoffs.filter((item) => item.expiresAt >= now);
  pruneContactState(draft, cutoff, now);
}

/**
 * The request table is capped: when it grows past `MAX_RECORDS`, drop the rows
 * that can no longer do anything. A `queued` or `running` row is never
 * removable, so the cap cannot strand work another window still owes. Moved
 * verbatim out of `RemoteRequestStore.enqueue`, where it was the one retention
 * rule not living with the rest; it still reassigns `draft.requests`, so the
 * array the schema parse and the write see is the trimmed one.
 */
export function trimRequestsToRecordCap(draft: RemoteStoreState): void {
  if (draft.requests.length > MAX_RECORDS) {
    const removable = draft.requests.filter((item) =>
      ['completed', 'failed', 'cancelled', 'unknown'].includes(item.state),
    );
    for (const old of removable.slice(0, draft.requests.length - MAX_RECORDS)) {
      draft.requests = draft.requests.filter((item) => item.id !== old.id);
    }
  }
}
