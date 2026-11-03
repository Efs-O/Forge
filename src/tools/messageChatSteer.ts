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

import type { ForgeHostStatus } from '../sidebar/ForgeHostFacade';
import type { ChatRef } from './chatMessageResolver';
import {
  atText,
  awaitMessageChatDelivery,
  clearUnclaimedSend,
  emitDeliveryActivity,
  formatDeliveryResult,
  HOUR_MS,
  markUnclaimedSend,
  messageChatSendLimit,
  nextAllowedAt,
  pruneMessageChatWindow,
  recordAction,
  rollbackAction,
  unclaimedSendRefusal,
  type MessageChatActionContext,
} from './messageChatShared';

const MESSAGE_CHAT_STEERS_PER_HOUR = 3;
const MESSAGE_CHAT_STEER_TARGET_GAP_MS = 2 * 60 * 1000;

export interface SteerContext extends MessageChatActionContext {
  target: ChatRef;
  to?: string;
}

interface SteerOrigin {
  senderId: string;
  baseEpoch?: number;
}

/** The `steer` action, with its two per-target maps in the closure: one sender's
 *  tool instance holds them for the whole window, the same as the send windows
 *  the tool holds alongside it. */
export function createSteerAction(): (input: SteerContext) => Promise<string> {
  const lastSteerByTarget = new Map<string, number>();
  const steerOrigins = new Map<string, SteerOrigin>();

  return async (input) => {
    const { sidebar, target, window, at, selfId } = input;
    pruneMessageChatWindow(window, at);
    const sendLimit = messageChatSendLimit(window, !target.running);
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

    const status: ForgeHostStatus = sidebar.getHostFacade().status();
    const activeIds = new Set([
      ...status.streamingConversationIds,
      ...status.requestChains.map((chain) => chain.conversationId),
    ]);
    for (const id of steerOrigins.keys()) {
      if (!activeIds.has(id)) steerOrigins.delete(id);
    }
    if (
      status.pendingApproval &&
      (status.pendingApproval.conversationId === undefined ||
        status.pendingApproval.conversationId === target.id)
    ) {
      return input.refuse(
        `Error: ${input.formatName(target)} is waiting for the owner's approval.`,
      );
    }
    const currentChain = status.requestChains.find((chain) => chain.conversationId === target.id);
    const origin = steerOrigins.get(target.id);
    if (!target.running) {
      steerOrigins.delete(target.id);
    } else if (origin?.senderId === selfId) {
      const epoch = currentChain?.userIntentEpoch;
      if (origin.baseEpoch === undefined || epoch === undefined || epoch <= origin.baseEpoch + 1) {
        return input.refuse(
          `Error: refusing a steer loop: ${input.formatName(target)} is still on a turn started by your earlier steer.`,
        );
      }
      steerOrigins.delete(target.id);
    }

    const idleWake = !target.running;
    lastSteerByTarget.set(target.id, at);
    const rollbackCooldown = (): void => {
      if (lastSteerByTarget.get(target.id) !== at) return;
      if (previous === undefined) lastSteerByTarget.delete(target.id);
      else lastSteerByTarget.set(target.id, previous);
    };
    recordAction(window, at, idleWake, false, true);
    let result: Awaited<ReturnType<typeof awaitMessageChatDelivery>>;
    try {
      result = await awaitMessageChatDelivery(
        sidebar.deliverChatMessage(input.formatMessage(), target.id, target.running),
        input.signal,
        () => clearUnclaimedSend(window, target.id),
      );
    } catch (error) {
      rollbackCooldown();
      rollbackAction(window, at, idleWake, false, true);
      return input.refuse(
        `Error: message_chat could not route the steering message: ${String(error)}.`,
      );
    }
    if (result.kind === 'refused') {
      rollbackCooldown();
      rollbackAction(window, at, idleWake, false, true);
      return input.refuse(
        `Error: ${input.formatName(target)} did not accept the steering message: ${result.error} Nothing was delivered; retry later or pick another chat.`,
      );
    }

    steerOrigins.set(target.id, {
      senderId: selfId,
      ...(currentChain ? { baseEpoch: currentChain.userIntentEpoch } : {}),
    });
    emitDeliveryActivity(input, target, result, target.running);
    if (idleWake && result.kind === 'tell') {
      const wakeIndex = window.wakesAt.lastIndexOf(at);
      if (wakeIndex >= 0) window.wakesAt.splice(wakeIndex, 1);
    }
    if (result.kind === 'unconfirmed') markUnclaimedSend(window, target.id, at);
    return formatDeliveryResult(input.formatName(target), result, 'steer');
  };
}
