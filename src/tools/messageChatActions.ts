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
import type { ForgeExchange } from '../sidebar/sessionProjections';
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
  emitPromptActivity,
  markUnclaimedSend,
  messageChatSendLimit,
  pruneMessageChatWindow,
  unclaimedSendRefusal,
  MESSAGE_CHAT_DELIVERY_CONFIRM_MS,
  MESSAGE_CHAT_NEW_CHATS_PER_HOUR_DEFAULT,
} from './messageChatShared';

/** The last prompt/answer pairs of one chat, as its supervisor can read them —
 *  from either side of the socket. `clamped` is measured where the answers live:
 *  a peer window slices to what it can send and says so, and this window counts
 *  its own fetch of one more than the view can show. Recomputing it from the
 *  array in hand would read a shortened transcript as the whole story. */
export function renderChatView(
  chat: { id: string; closed?: boolean },
  name: string,
  fetched: readonly ForgeExchange[],
  streaming: boolean,
  clamped: boolean,
): string {
  // Belt and braces: a transcript that arrives longer than the view allows is
  // cut here too, so a peer that ignored the cap cannot overflow the answer.
  const exchanges =
    fetched.length > MAX_VIEW_COUNT ? fetched.slice(fetched.length - MAX_VIEW_COUNT) : fetched;
  // A closed chat has no tab to name it by, so the header says `closed` instead
  // of `#N` — the supervisor needs to know it cannot send there — and nothing
  // can be mid-turn in a chat that is not open, so the streaming note is off.
  const closed = chat.closed === true;
  return (
    `View of ${name} (id ${chat.id}${closed ? ', closed' : ''}):\n\n` +
    renderBusView(exchanges, {
      clamped,
      streaming: !closed && streaming,
    })
  );
}

/** `view` on a chat this window holds: read the transcript, render it. */
function localView(input: ViewContext): string {
  // A chat this window does not hold answers with nothing, which `renderBusView`
  // reports as no answers yet. One more exchange than the view can show is
  // fetched, so "there was more" is a measurement and not a guess: the agent
  // bus's own `/view` route clamps the same way and says so in its note.
  const fetched = input.sidebar
    .getHostFacade()
    .recentExchanges(input.target.id, MAX_VIEW_COUNT + 1);
  return renderChatView(
    input.target,
    input.formatName(input.target),
    fetched,
    input.chats.some((chat) => chat.id === input.target.id && chat.running),
    fetched.length > MAX_VIEW_COUNT,
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
    view: localView,
  };
}
