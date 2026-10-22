import type { RemoteOutboxRecord, RemoteRequestRecord } from './types';
import { OUTBOX_STATE_ROLE, type RemoteStoreState } from './RemoteStoreSchemas';

export function remoteDedupKey(channel: string, chatId: string, messageId: string): string {
  return `${channel}\u0000${chatId}\u0000${messageId}`;
}

export function pendingOutbox(
  state: RemoteStoreState,
  channel?: RemoteOutboxRecord['channel'],
): RemoteOutboxRecord[] {
  return state.outbox.filter(
    (item) =>
      OUTBOX_STATE_ROLE[item.state] === 'deliverable' &&
      (channel === undefined || item.channel === channel),
  );
}

export function outboxHealth(state: RemoteStoreState): {
  pending: number;
  sending: number;
  abandoned: number;
} {
  const roleCount = (role: 'deliverable' | 'in_flight') =>
    state.outbox.filter((item) => OUTBOX_STATE_ROLE[item.state] === role).length;
  return {
    pending: roleCount('deliverable'),
    sending: roleCount('in_flight'),
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
