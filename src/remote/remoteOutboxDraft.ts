import { randomUUID } from 'crypto';
import type { RemoteOutboxRecord } from './types';
import type { RemoteStoreState } from './RemoteStoreSchemas';

/** Add a host notice to the durable outbox in the store's locked draft. */
export function appendHostNotification(
  draft: RemoteStoreState,
  channel: RemoteOutboxRecord['channel'],
  chatId: string,
  text: string,
  ephemeral = false,
): void {
  draft.outbox.push({
    id: randomUUID(),
    requestId: `host-${randomUUID()}`,
    channel,
    chatId,
    text,
    state: 'pending',
    attempts: 0,
    updatedAt: Date.now(),
    ...(ephemeral ? { ephemeral: true } : {}),
  });
}
