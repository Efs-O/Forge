/**
 * Pure state transitions for workspace handoffs, kept out of the store the way
 * selection state is: the store owns persistence and serialization, these
 * decide what a handoff record becomes. Every one of them takes `now` so a test
 * can sit either side of an expiry without waiting for one.
 */

import type { RemoteBinding } from './types';
import type { RemoteStoreState, WorkspaceHandoff } from './RemoteStoreSchemas';

/** A switch the target window has this long to claim before it is abandoned. */
const HANDOFF_TTL_MS = 5 * 60_000;

export type HandoffInput = Omit<
  WorkspaceHandoff,
  'id' | 'state' | 'createdAt' | 'updatedAt' | 'expiresAt'
>;

/** One chat can only be mid-switch once: a second /new replaces the first. */
export function replaceHandoffForChat(
  list: readonly WorkspaceHandoff[],
  input: HandoffInput,
  now: number,
  id: string,
): WorkspaceHandoff[] {
  const kept = list.filter(
    (item) => item.channel !== input.channel || item.chatId !== input.chatId,
  );
  kept.push({
    ...input,
    id,
    state: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + HANDOFF_TTL_MS,
  });
  return kept;
}

function claimable(handoff: WorkspaceHandoff, workspaceId: string, now: number): boolean {
  return (
    handoff.state === 'pending' &&
    handoff.targetWorkspaceId === workspaceId &&
    handoff.expiresAt > now
  );
}

export function hasPendingHandoff(
  list: readonly WorkspaceHandoff[],
  workspaceId: string,
  now: number,
): boolean {
  return list.some((handoff) => claimable(handoff, workspaceId, now));
}

/**
 * The handoffs this window may take, read **without** claiming them.
 *
 * The target window opens the conversation it is going to bind before it
 * touches the store, so nothing durable exists while that open is in flight.
 * Whether a record is still claimable is decided again inside the write that
 * claims, binds and completes it — this read is only a preview, and two
 * windows that both see it cannot both win, because the write re-checks.
 */
export function peekClaimable(
  list: readonly WorkspaceHandoff[],
  workspaceId: string,
  now: number,
): WorkspaceHandoff[] {
  return list
    .filter((item) => claimable(item, workspaceId, now))
    .map((item) => structuredClone(item));
}

/**
 * Claim, bind and complete one handoff in a single draft write.
 *
 * Returns `false` when another window got there first, which is the whole
 * point: the old order claimed the record, then awaited the conversation
 * open, then wrote the binding, so a reload or crash in that gap left the
 * record `claimed` — and only `pending` records are claimable, so nothing
 * could take it back while the source window had already stopped serving.
 * Completing in the same write means there is no observable middle state to
 * strand, so no `claimedBy` field and no dead-claimer recovery is needed.
 */
export function claimBindAndComplete(
  state: RemoteStoreState,
  handoffId: string,
  workspaceId: string,
  now: number,
  binding?: RemoteBinding,
): { ok: true; handoff: WorkspaceHandoff } | { ok: false } {
  const handoff = state.workspaceHandoffs.find((item) => item.id === handoffId);
  if (!handoff || !claimable(handoff, workspaceId, now)) return { ok: false };
  if (binding) {
    state.bindings = state.bindings.filter(
      (item) => item.channel !== binding.channel || item.chatId !== binding.chatId,
    );
    state.bindings.push(binding);
  }
  handoff.state = 'completed';
  handoff.updatedAt = now;
  return { ok: true, handoff: structuredClone(handoff) };
}

/**
 * The mode a record means. An absent `mode` is `replace` — the only behaviour
 * there has ever been — so a window still running an older build can send a
 * record this build reads as today's switch instead of an accident.
 */
export function handoffMode(handoff: WorkspaceHandoff): 'replace' | 'new-window' {
  return handoff.mode ?? 'replace';
}

/**
 * The source window undoing a switch that never happened. A record another
 * window has already claimed is left alone — that window is serving the chat
 * now, and undoing it would strand the conversation it just bound.
 */
export function failUnclaimedHandoff(
  list: WorkspaceHandoff[],
  id: string,
  now: number,
): 'failed' | 'claimed' | 'gone' {
  const handoff = list.find((item) => item.id === id);
  if (!handoff) return 'gone';
  if (handoff.state !== 'pending') return 'claimed';
  handoff.state = 'failed';
  handoff.updatedAt = now;
  return 'failed';
}
