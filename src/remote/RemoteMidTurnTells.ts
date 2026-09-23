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
 * Claim every queued, text-only, normal-priority request for a conversation
 * whose chat can be reached, in queue order, or nothing. A record the drain
 * already claimed (or that carries an attachment, or is a steer) is left
 * `queued` for the next turn. The returned `settle` finishes each claimed
 * record, in order, only after the injected messages have been persisted.
 */
export async function claimRemoteMidTurnTell(
  store: RemoteRequestStore,
  canDeliver: CanDeliver,
  conversationId: string,
): Promise<MidTurnDrainResult> {
  const candidates = store.queued(conversationId).sort(compareQueuedRequests);
  const claimed: RemoteRequestRecord[] = [];
  for (const candidate of candidates) {
    if (candidate.priority === 'steer') continue;
    if (candidate.attachments?.length) continue;
    if (!(await canDeliver(candidate.channel, candidate.chatId))) continue;
    const taken = await store.claimMidTurnTell(candidate.id);
    if (taken) claimed.push(taken);
  }
  if (claimed.length === 0) return { messages: [] };
  return {
    messages: claimed.map((record) => ({
      role: 'user',
      content: record.text,
      midTurn: true,
    })),
    settle: async () => {
      for (const record of claimed) {
        await store.finish(record.id, 'completed', {
          notification: 'Seen by the running turn.',
        });
      }
    },
  };
}
