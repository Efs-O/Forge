/**
 * Claims a conversation's queued, normal-priority, text-only remote request as a
 * mid-turn tell so it reaches the running turn at the next tool-round gap
 * instead of waiting for the turn to end (MID_TURN_TELL_PLAN, Phase 3).
 *
 * The claim is atomic against `RemoteQueueDrain`: `claimMidTurnTell` re-checks
 * that the record is still `queued` inside the store's serialized mutation, so a
 * record the drain already took is skipped, not injected. The returned `settle`
 * finishes the record only after the injected message has been persisted.
 */

import type { MidTurnDrainResult } from '../agent/MidTurnInbox';
import type { RemoteRequestStore } from './RemoteRequestStore';
import { compareQueuedRequests } from './remoteQueueOrdering';
import type { RemoteRequestRecord } from './types';

export type CanDeliver = (
  channel: RemoteRequestRecord['channel'],
  chatId: string,
) => Promise<boolean>;

/**
 * Claim the first queued, text-only, normal-priority request for a conversation
 * whose chat can be reached, or nothing. A record the drain already claimed (or
 * that carries an attachment, or is a steer) is left `queued` for the next turn.
 */
export async function claimRemoteMidTurnTell(
  store: RemoteRequestStore,
  canDeliver: CanDeliver,
  conversationId: string,
): Promise<MidTurnDrainResult> {
  const candidates = store.queued(conversationId).sort(compareQueuedRequests);
  for (const candidate of candidates) {
    if (candidate.priority === 'steer') continue;
    if (candidate.attachments?.length) continue;
    if (!(await canDeliver(candidate.channel, candidate.chatId))) continue;
    const claimed = await store.claimMidTurnTell(candidate.id);
    if (!claimed) continue;
    return {
      messages: [{ role: 'user', content: candidate.text, midTurn: true }],
      settle: () =>
        store.finish(claimed.id, 'completed', {
          notification: 'Seen by the running turn.',
        }),
    };
  }
  return { messages: [] };
}
