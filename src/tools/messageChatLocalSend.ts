/**
 * `message_chat action=send` into a chat THIS window holds: the send and
 * idle-wake caps, the one-unclaimed-send-per-target guard, the wait for delivery
 * to be admitted, the two transcript mirror lines, the counter commits, and the
 * three sentences the sender reads.
 *
 * Split out of `messageChatTool.ts` for the 500-line `max-lines` cap (plan:
 * `docs/plans/MESSAGE_CHAT_TOOL_SPLIT_PLAN.md`). This was the last action body
 * still living in the dispatcher: `new` sits in `messageChatNewChat.ts`, `steer`
 * in `messageChatSteer.ts`, `view` in `messageChatActions.ts` and all four peer
 * routes in `messageChatPeerActions.ts`, so the tool file is now dispatch only —
 * parse, resolve the reference, route, and let this module phrase the answer.
 *
 * It is also the only path that mutates the sender's rolling window as a side
 * effect of a DELIVERY RESULT rather than of admitting a call: an unconfirmed
 * send counts against both the send and the idle-wake cap and is remembered as
 * outstanding, because the 20-second wait is a guess about admission and the
 * message may still start.
 */

import { clipMirroredPrompt } from '../sidebar/turnMirrorWiring';
import { formatChatMirrorLine } from '../sidebar/chatMessageText';
import { formatChatName, type ChatRef } from './chatMessageResolver';
import {
  awaitMessageChatDelivery,
  clearUnclaimedSend,
  emitPromptActivity,
  markUnclaimedSend,
  MESSAGE_CHAT_DELIVERY_CONFIRM_MS,
  messageChatSendLimit,
  unclaimedSendRefusal,
  type MessageChatActionContext,
  type MessageChatActionSidebar,
  type MessageChatDeliveryResult,
} from './messageChatShared';
import { listRefusal, messageFrom } from './messageChatToolFormatting';

export interface LocalSendContext extends Omit<
  MessageChatActionContext,
  // Not used on this path: the body calls the owners directly (`listRefusal`,
  // `formatChatName`, `emitPromptActivity`, `formatChatMirrorLine`), which is
  // what keeps its lines byte-identical to the dispatcher they moved from.
  | 'message'
  | 'formatMessage'
  | 'pinModel'
  | 'steerAvailable'
  | 'refuse'
  | 'formatName'
  | 'emitActivity'
  | 'formatMirrorLine'
> {
  message: string;
  target: ChatRef;
  /** The facade the mirror lines are drawn on: this path calls
   *  `emitPromptActivity(hostFacade, …)` directly rather than through the
   *  context's `emitActivity`, and the move kept that. */
  hostFacade: ReturnType<MessageChatActionSidebar['getHostFacade']>;
  /** The inferred-send suffix, applied to every result on the send path. */
  say(result: string): string;
}

/** Deliver `message` to a chat this window holds, and say what happened. */
export async function localSend(input: LocalSendContext): Promise<string> {
  const {
    target,
    window,
    at,
    selfId,
    chats,
    sender,
    sidebar,
    hostFacade,
    unattended,
    message,
    say,
    signal,
  } = input;
  const sendLimit = messageChatSendLimit(window, !target.running);
  if (sendLimit) return say(listRefusal(sendLimit, chats, selfId));
  // Refused before anything is counted or sent: an earlier message from this
  // chat to the same target has not been seen to start, so a second one would
  // deliver the same report twice. Only an idle target can get here, because
  // a send into a busy chat is admitted as a tell at once.
  const unclaimed = unclaimedSendRefusal(window, target.id, formatChatName(target));
  if (unclaimed) return say(listRefusal(unclaimed, chats, selfId));

  let delivery: MessageChatDeliveryResult;
  try {
    delivery = await awaitMessageChatDelivery(
      unattended
        ? sidebar.deliverChatMessage(
            messageFrom(sender, chats, message),
            target.id,
            false,
            unattended,
          )
        : sidebar.deliverChatMessage(messageFrom(sender, chats, message), target.id),
      signal,
      () => clearUnclaimedSend(window, target.id),
    );
  } catch (error) {
    return say(
      listRefusal(
        `Error: message_chat could not route the message: ${String(error)}. Retry when the sidebar is available.`,
        chats,
        selfId,
      ),
    );
  }
  const name = formatChatName(target);
  if (delivery.kind === 'refused') {
    return say(
      listRefusal(
        `Error: ${name} did not accept the message: ${delivery.error} Nothing was delivered; retry later or pick another chat.`,
        chats,
        selfId,
      ),
    );
  }
  const body = clipMirroredPrompt(message);
  const mirrorStatus =
    delivery.kind === 'tell' ? 'tell' : delivery.kind === 'turn' ? 'turn' : 'unconfirmed';
  emitPromptActivity(
    hostFacade,
    target.id,
    formatChatMirrorLine('in', sender.title, undefined, body),
  );
  emitPromptActivity(
    hostFacade,
    sender.id,
    formatChatMirrorLine('out', target.title, mirrorStatus, body),
  );
  // An unconfirmed send may still start, so it counts against both caps.
  window.sentAt.push(at);
  if (delivery.kind !== 'tell') window.wakesAt.push(at);
  // And it is remembered as outstanding, so while it is the same chat cannot
  // send to the same target again and pay for the report twice. The real
  // delivery settling late clears this, so a retry is allowed once it starts
  // or is refused; otherwise the mark dies with the hour.
  if (delivery.kind === 'unconfirmed') markUnclaimedSend(window, target.id, at);
  if (delivery.kind === 'tell')
    return say(
      `Queued for ${name} (running): not processed yet; it will be read at a tool round or in a follow-up turn.`,
    );
  if (delivery.kind === 'turn') return say(`Delivered to ${name} (idle): a turn started there.`);
  return say(
    `Sent to ${name}, but its turn had not started after ${delivery.why === 'timeout' ? `${MESSAGE_CHAT_DELIVERY_CONFIRM_MS / 1000} s` : 'this turn was stopped'}; it may still start. Do not resend; check with \`list\` later.`,
  );
}
