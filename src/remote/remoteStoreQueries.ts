import type { RemoteOutboxRecord, RemoteRequestRecord } from './types';
import type { RemoteStoreState } from './RemoteStoreSchemas';

export function pendingOutbox(
  state: RemoteStoreState,
  channel?: RemoteOutboxRecord['channel'],
): RemoteOutboxRecord[] {
  return state.outbox.filter(
    (item) => item.state === 'pending' && (channel === undefined || item.channel === channel),
  );
}

export function outboxHealth(state: RemoteStoreState): {
  pending: number;
  sending: number;
  abandoned: number;
} {
  return {
    pending: state.outbox.filter((item) => item.state === 'pending').length,
    sending: state.outbox.filter((item) => item.state === 'sending').length,
    abandoned: state.outbox.filter((item) => item.state === 'abandoned').length,
  };
}

export function requestHealth(state: RemoteStoreState): {
  queued: number;
  running: number;
  unknown: number;
} {
  return {
    queued: state.requests.filter((item) => item.state === 'queued').length,
    running: state.requests.filter((item) => item.state === 'running').length,
    unknown: state.requests.filter((item) => item.state === 'unknown').length,
  };
}

export function requestHealthForConversation(
  state: RemoteStoreState,
  conversationId: string,
): { queued: number; running: number; unknown: number } {
  const count = (status: RemoteRequestRecord['state']) =>
    state.requests.filter(
      (item) =>
        typeof item.conversationId === 'string' &&
        item.conversationId.length > 0 &&
        item.conversationId === conversationId &&
        item.state === status,
    ).length;
  return { queued: count('queued'), running: count('running'), unknown: count('unknown') };
}
