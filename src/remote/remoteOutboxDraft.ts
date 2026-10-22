import { randomUUID } from 'crypto';
import type { RemoteOutboxRecord } from './types';
import type { OutboxState, RemoteStoreState } from './RemoteStoreSchemas';

/** Add a host notice to the durable outbox in the store's locked draft; returns its id. */
export function appendHostNotification(
  draft: RemoteStoreState,
  channel: RemoteOutboxRecord['channel'],
  chatId: string,
  text: string,
  ephemeral = false,
  requestId = `host-${randomUUID()}`,
): string {
  const id = randomUUID();
  draft.outbox.push({
    id,
    requestId,
    channel,
    chatId,
    text,
    state: 'pending',
    attempts: 0,
    updatedAt: Date.now(),
    ...(ephemeral ? { ephemeral: true } : {}),
  });
  return id;
}

/** Batch outbox disposition for one locked chat's unlock backlog. */
export function updateOutboxStates(
  draft: RemoteStoreState,
  ids: readonly string[],
  state: Extract<OutboxState, 'pending' | 'coalesced'>,
): void {
  const selected = new Set(ids);
  for (const item of draft.outbox) {
    if (selected.has(item.id) && (item.state === 'pending' || item.state === 'coalesced')) {
      item.state = state;
      item.updatedAt = Date.now();
    }
  }
}
