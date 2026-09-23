import type { RemoteRequestRecord } from './types';

/**
 * Queue order for one conversation, and the draft mutations that depend on it.
 *
 * Split from `RemoteRequestStore` on the same seam as `RemoteHandoffState` and
 * `RemoteSelectionState`: pure functions over a mutable draft, so the store
 * keeps sole ownership of loading, serializing and persisting state while the
 * ordering rules live where they can be read in one sitting. Every caller must
 * go through `compareQueuedRequests` — a second sort written inline is how a
 * promoted prompt silently stops being next.
 */
export function compareQueuedRequests(
  left: RemoteRequestRecord,
  right: RemoteRequestRecord,
): number {
  const priority = Number(right.priority === 'steer') - Number(left.priority === 'steer');
  return priority || (left.admittedAt ?? left.receivedAt) - (right.admittedAt ?? right.receivedAt);
}

function queuedFor(requests: RemoteRequestRecord[], conversationId: string): RemoteRequestRecord[] {
  return requests.filter(
    (item) => item.conversationId === conversationId && item.state === 'queued',
  );
}

/**
 * Move one queued prompt to the front of its conversation's queue.
 *
 * Order is priority THEN `admittedAt`, so promotion has to do both: flag it as
 * a steer AND date it before every other queued row, or it merely joins the
 * back of an existing steer run.
 */
export function promoteQueuedInDraft(
  requests: RemoteRequestRecord[],
  conversationId: string,
  requestId: string,
): boolean {
  const queued = queuedFor(requests, conversationId);
  const target = queued.find((item) => item.id === requestId);
  if (!target) return false;
  const earliest = Math.min(...queued.map((item) => item.admittedAt ?? item.receivedAt));
  target.priority = 'steer';
  target.admittedAt = earliest - 1;
  target.updatedAt = Date.now();
  return true;
}

/** Mark selected queued prompts cancelled without deleting their audit record. */
export function cancelQueuedInDraft(
  requests: RemoteRequestRecord[],
  conversationId: string,
  requestIds?: ReadonlySet<string>,
): number {
  const selected = queuedFor(requests, conversationId).filter(
    (request) => !requestIds || requestIds.has(request.id),
  );
  for (const request of selected) {
    request.state = 'cancelled';
    request.updatedAt = Date.now();
  }
  return selected.length;
}

/**
 * Claim the next queued prompt for a conversation, or nothing.
 *
 * A conversation already running keeps its claim: two windows draining the same
 * shared state file must not both take work for it.
 */
export function claimNextInDraft(
  requests: RemoteRequestRecord[],
  conversationId: string,
  channel: RemoteRequestRecord['channel'],
): string | undefined {
  if (requests.some((item) => item.conversationId === conversationId && item.state === 'running')) {
    return undefined;
  }
  const next = queuedFor(requests, conversationId).sort(compareQueuedRequests)[0];
  if (!next || next.channel !== channel) return undefined;
  next.state = 'running';
  next.updatedAt = Date.now();
  return next.id;
}

/**
 * Atomically claim one queued request as a mid-turn tell, or nothing.
 *
 * Unlike `claimNextInDraft` this does not stop at a running conversation: the
 * tell is injected into the turn that is already running, so the guard would
 * reject every claim. It still re-checks the record is `queued` so a request
 * `RemoteQueueDrain` already took is skipped rather than double-injected.
 */
export function claimMidTurnTellInDraft(
  requests: RemoteRequestRecord[],
  requestId: string,
): RemoteRequestRecord | undefined {
  const request = requests.find((item) => item.id === requestId);
  if (!request || request.state !== 'queued') return undefined;
  request.state = 'running';
  request.updatedAt = Date.now();
  return structuredClone(request);
}
