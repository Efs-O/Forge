/**
 * `message_chat action=steer`: put a message into a chat that may be mid-turn,
 * through the same "Send now" route the sidebar button uses.
 *
 * Split out of `messageChatActions.ts` for the 500-line `max-lines` cap. This is
 * the action with state of its own — the per-target two-minute cooldown and the
 * record of which sender last started a turn here — because steering is the only
 * action that can make a chat stop what it is doing, so it is the only one that
 * can start a loop: a chat answers a steer by replying to the chat that steered
 * it, which steers back. The loop guard is what makes that a conversation and
 * not a ping-pong that burns two models until the hour runs out.
 */

import type { ChatRef } from './chatMessageResolver';
import {
  atText,
  awaitMessageChatDelivery,
  clearUnclaimedSend,
  emitDeliveryActivity,
  formatDeliveryResult,
  markUnclaimedSend,
  messageChatSendLimit,
  nextAllowedAt,
  pruneMessageChatWindow,
  recordAction,
  rollbackAction,
  unclaimedSendRefusal,
  type DeliveryOutcome,
  type MessageChatActionContext,
  type MessageChatDeliveryResult,
} from './messageChatShared';

const MESSAGE_CHAT_STEERS_PER_HOUR = 3;
/** Steer keeps the full hour: the cadence `lastSteerByTarget` enforces is a
 *  per-target hour, independent of the 30-minute send/wake window. */
const HOUR_MS = 60 * 60 * 1000;
const MESSAGE_CHAT_STEER_TARGET_GAP_MS = 2 * 60 * 1000;

export interface SteerContext extends MessageChatActionContext {
  target: ChatRef;
  to?: string;
  /** The chats this window (or a peer's fresh chat list) says are mid-turn. The
   *  loop guard forgets a chat that left this set, so a finished turn cannot
   *  hold the guard forever. */
  activeIds: Set<string>;
  /** What this caller actually read. `self` means every chat in THIS window, so
   *  the loop memory of a chat in another window is left alone; `target` means
   *  one chat in one window — a peer's chat list answers for the chat it names,
   *  and nothing else. The default is `self`. */
  readScope?: 'self' | 'target';
  /** How the text reaches the target: the sidebar's router locally, another
   *  window's route for a peer. A peer may only be able to say the outcome is
   *  unknown, and then the cooldown and the counters stay where they are. */
  deliver(text: string, conversationId: string, running: boolean): Promise<DeliveryOutcome>;
  /** The sentence this action earns, for a caller whose delivery means something
   *  the local wording does not describe — a peer that interrupted its turn
   *  deserves to be told so, not told "only if it is generating one". */
  formatResult?(result: MessageChatDeliveryResult): string;
}

interface SteerOrigin {
  senderId: string;
  baseEpoch?: number;
  /** Which read can speak for this chat: `self` for a chat in this window, or
   *  `target` for one this caller learned about from a single-chat report — a
   *  peer's chat list, or any read that names one chat. A `self` read cannot
   *  forget a `target` origin: this window's chat list never mentions a chat it
   *  does not hold, so its absence there says nothing about that turn. */
  scope: 'self' | 'target';
}

/** The `steer` action, with its two per-target maps in the closure: one sender's
 *  tool instance holds them for the whole window, the same as the send windows
 *  the tool holds alongside it. */
export function createSteerAction(): (input: SteerContext) => Promise<string> {
  const lastSteerByTarget = new Map<string, number>();
  const steerOrigins = new Map<string, SteerOrigin>();

  return async (input) => {
    const { target, window, at, selfId } = input;
    pruneMessageChatWindow(window, at);
    const sendLimit = messageChatSendLimit(window, true);
    if (sendLimit) return input.refuse(sendLimit);
    if (window.steersAt.length >= MESSAGE_CHAT_STEERS_PER_HOUR) {
      return input.refuse(
        `Error: the ${MESSAGE_CHAT_STEERS_PER_HOUR}-steer-per-hour limit for this chat was reached; the next steer is allowed at ${atText(nextAllowedAt(window.steersAt))}.`,
      );
    }
    for (const [id, previousAt] of lastSteerByTarget) {
      if (at - previousAt >= HOUR_MS) lastSteerByTarget.delete(id);
    }
    const previous = lastSteerByTarget.get(target.id);
    if (previous !== undefined && at - previous < MESSAGE_CHAT_STEER_TARGET_GAP_MS) {
      return input.refuse(
        `Error: this chat was steered too recently; the next steer to it is allowed at ${atText(previous + MESSAGE_CHAT_STEER_TARGET_GAP_MS)}.`,
      );
    }

    // A steer is still a message, so it is refused while an earlier send to this
    // chat has not started: checking before `recordAction` means a refusal here
    // burns no send, no wake and no steer counter.
    const unclaimed = unclaimedSendRefusal(window, target.id, input.formatName(target));
    if (unclaimed) return input.refuse(unclaimed);

    // The target's own state travels with its ref, so the same guard runs on a
    // chat in another window: `chatRefs` fills it from `status()` here, a peer's
    // chat list fills it over there. A read may only forget the chats it covered:
    // a peer's list speaks for the one chat it names, and this window's list
    // speaks for none of the chats it does not hold. Erasing the rest would let a
    // chat still on a steered turn be steered again — the loop this guard stops.
    for (const [id, origin] of steerOrigins) {
      const covered = id === target.id || (input.readScope !== 'target' && origin.scope === 'self');
      if (covered && !input.activeIds.has(id)) steerOrigins.delete(id);
    }
    if (target.awaitingApproval) {
      return input.refuse(
        `Error: ${input.formatName(target)} is waiting for the owner's approval.`,
      );
    }
    const currentEpoch = target.userIntentEpoch;
    const origin = steerOrigins.get(target.id);
    if (!target.running) {
      steerOrigins.delete(target.id);
    } else if (origin?.senderId === selfId) {
      const epoch = currentEpoch;
      if (origin.baseEpoch === undefined || epoch === undefined || epoch <= origin.baseEpoch + 1) {
        return input.refuse(
          `Error: refusing a steer loop: ${input.formatName(target)} is still on a turn started by your earlier steer.`,
        );
      }
      steerOrigins.delete(target.id);
    }

    // The wake is reserved before the message leaves, whatever the snapshot said:
    // a steer can start a turn in a chat this window believed was mid-turn, and a
    // cap that is only checked after the answer has let one turn through already.
    // It is handed back below, and only on proof — when the receiver says it
    // stopped a turn, the chat was busy and this steer added no wake.
    lastSteerByTarget.set(target.id, at);
    const wakeReserved = true;
    const rollbackCooldown = (): void => {
      if (lastSteerByTarget.get(target.id) !== at) return;
      if (previous === undefined) lastSteerByTarget.delete(target.id);
      else lastSteerByTarget.set(target.id, previous);
    };
    recordAction(window, at, wakeReserved, false, true);
    let result: Awaited<ReturnType<typeof awaitMessageChatDelivery>>;
    try {
      result = await awaitMessageChatDelivery(
        input.deliver(input.formatMessage(), target.id, target.running),
        input.signal,
        () => clearUnclaimedSend(window, target.id),
      );
    } catch (error) {
      rollbackCooldown();
      rollbackAction(window, at, wakeReserved, false, true);
      return input.refuse(
        `Error: message_chat could not route the steering message: ${String(error)}.`,
      );
    }
    if (result.kind === 'refused') {
      // A lost answer after the bytes left is not a refusal: the other window may
      // have interrupted its turn already, so the cooldown and the counters stay
      // and the sender is told not to resend.
      const certain = !('uncertain' in result && result.uncertain === true);
      if (certain) {
        rollbackCooldown();
        rollbackAction(window, at, wakeReserved, false, true);
      }
      return input.refuse(
        certain
          ? `Error: ${input.formatName(target)} did not accept the steering message: ${result.error} Nothing was delivered; retry later or pick another chat.`
          : `Error: ${input.formatName(target)} did not confirm the steering message: ${result.error}. It may already be queued there, so do not resend; the steer stays counted against your caps.`,
      );
    }

    steerOrigins.set(target.id, {
      senderId: selfId,
      ...(currentEpoch === undefined ? {} : { baseEpoch: currentEpoch }),
      scope: input.readScope === 'target' ? 'target' : 'self',
    });
    emitDeliveryActivity(input, target, result, target.running);
    // The refund for the reserved wake, and the only one: the receiver answered
    // that it stopped a turn, so the chat was busy and no turn was added. A
    // `turn` outcome keeps the charge even when the snapshot said the chat was
    // running — a stale snapshot owes that turn, and over-charging is the only
    // error a cap is allowed to make.
    if (result.kind === 'tell') {
      const wakeIndex = window.wakesAt.lastIndexOf(at);
      if (wakeIndex >= 0) window.wakesAt.splice(wakeIndex, 1);
    }
    if (result.kind === 'unconfirmed') markUnclaimedSend(window, target.id, at);
    return (
      input.formatResult?.(result) ??
      formatDeliveryResult(input.formatName(target), result, 'steer')
    );
  };
}
