/**
 * Pure state transitions for workspace handoffs, kept out of the store the way
 * selection state is: the store owns persistence and serialization, these
 * decide what a handoff record becomes. Every one of them takes `now` so a test
 * can sit either side of an expiry without waiting for one.
 */

import type { WorkspaceHandoff } from './RemoteStoreSchemas';

/** A switch the target window has this long to claim before it is abandoned. */
export const HANDOFF_TTL_MS = 5 * 60_000;

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

/** Marks every claimable handoff for this workspace claimed, in place, and
 *  returns copies of what it took. */
export function claimHandoffs(
  list: WorkspaceHandoff[],
  workspaceId: string,
  now: number,
): WorkspaceHandoff[] {
  const claimed: WorkspaceHandoff[] = [];
  for (const handoff of list) {
    if (!claimable(handoff, workspaceId, now)) continue;
    handoff.state = 'claimed';
    handoff.updatedAt = now;
    claimed.push(structuredClone(handoff));
  }
  return claimed;
}

export function completeHandoff(list: WorkspaceHandoff[], id: string, now: number): void {
  const handoff = list.find((item) => item.id === id);
  if (!handoff) return;
  handoff.state = 'completed';
  handoff.updatedAt = now;
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
