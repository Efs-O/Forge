import { randomUUID } from 'crypto';
import type { RemoteOutboxRecord } from './types';
import type { RemoteStoreState } from './RemoteStoreSchemas';

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
