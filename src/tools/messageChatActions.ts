/**
 * The `message_chat` action set, assembled: `new`, `steer` and `view`, plus the
 * read-only transcript view that belongs here rather than in its own file.
 *
 * Each action's implementation lives in its own module (`messageChatNewChat.ts`,
 * `messageChatSteer.ts`) over the shared counters in `messageChatShared.ts`;
 * this file is the seam the tool calls through, so the tool has one import for
 * actions and one for the schema it advertises.
 */

import { MAX_VIEW_COUNT } from '../remote/RemoteTranscriptView';
import { renderBusView } from '../agentBus/busStatusView';
import type { ChatRef } from './chatMessageResolver';
import { createNewChat } from './messageChatNewChat';
import { createSteerAction, type SteerContext } from './messageChatSteer';
import type { MessageChatActionContext } from './messageChatShared';

/** `view` reads one named chat: no message, no delivery, no counter burned. */
export interface ViewContext extends MessageChatActionContext {
  target: ChatRef;
}

export type {
  MessageChatActionContext,
  MessageChatActionSidebar,
  MessageChatDeliveryResult,
  MessageChatWindow,
} from './messageChatShared';
export {
  awaitMessageChatDelivery,
  clearUnclaimedSend,
  markUnclaimedSend,
  messageChatSendLimit,
  pruneMessageChatWindow,
  unclaimedSendRefusal,
  MESSAGE_CHAT_DELIVERY_CONFIRM_MS,
  MESSAGE_CHAT_NEW_CHATS_PER_HOUR_DEFAULT,
} from './messageChatShared';

/** The last prompt/answer pairs of one chat, as its supervisor can read them. */
function renderChatView(input: ViewContext): string {
  const facade = input.sidebar.getHostFacade();
  // One more exchange than the view can show, so "there was more" is a
  // measurement and not a guess: the agent bus's own `/view` route clamps the
  // same way and says so in its note. A chat this window does not hold answers
  // with nothing, which `renderBusView` reports as no answers yet.
  const fetched = facade.recentExchanges(input.target.id, MAX_VIEW_COUNT + 1);
  const clamped = fetched.length > MAX_VIEW_COUNT;
  const exchanges = clamped ? fetched.slice(fetched.length - MAX_VIEW_COUNT) : fetched;
  // A closed chat has no tab to name it by, so the header says `closed` instead
  // of `#N` — the supervisor needs to know it cannot send there — and nothing
  // can be mid-turn in a chat that is not open, so the streaming note is off.
  const closed = input.target.closed === true;
  return (
    `View of ${input.formatName(input.target)} (id ${input.target.id}${closed ? ', closed' : ''}):\n\n` +
    renderBusView(exchanges, {
      clamped,
      streaming: !closed && input.chats.some((chat) => chat.id === input.target.id && chat.running),
    })
  );
}

export function createMessageChatActions(): {
  createNewChat(input: MessageChatActionContext): Promise<string>;
  steer(input: SteerContext): Promise<string>;
  view(input: ViewContext): string;
} {
  return {
    createNewChat,
    steer: createSteerAction(),
    view: renderChatView,
  };
}
