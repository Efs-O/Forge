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
