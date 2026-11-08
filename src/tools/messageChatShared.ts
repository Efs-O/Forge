/**
 * What every `message_chat` action shares: the per-sender rolling windows and
 * their caps, the wait for delivery to be admitted, and the mirror and result
 * text both write.
 *
 * Split out of `messageChatActions.ts` for the 500-line `max-lines` cap. The
 * three actions now sit in their own files — `new` in `messageChatNewChat.ts`,
 * `steer` in `messageChatSteer.ts`, `view` and the composition in
 * `messageChatActions.ts` — and this module is the one they all depend on
 * without depending back on any of them, so there is no import cycle between
 * them. Keeping the counters here is also what keeps them honest: a `new` and a
 * `steer` record themselves through the same `recordAction`/`rollbackAction`
 * pair, so a refunded send cannot be refunded by one action and not the other.
 */

import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { logger } from '../util/logger';
import type { ChatMessageDelivery } from '../sidebar/backgroundExitNotice';
import type { ChatMessageMirrorStatus } from '../sidebar/chatMessageText';
import { clipMirroredPrompt } from '../sidebar/turnMirrorWiring';
import type { ChatRef } from './chatMessageResolver';

export const HOUR_MS = 60 * 60 * 1000;
const MESSAGE_CHAT_SENDS_PER_HOUR = 30;
const MESSAGE_CHAT_IDLE_WAKES_PER_HOUR = 6;
/** The default of `permissions.chats.new_chats_per_hour`, which a config raises. */
export const MESSAGE_CHAT_NEW_CHATS_PER_HOUR_DEFAULT = 2;
export const MESSAGE_CHAT_DELIVERY_CONFIRM_MS = 20_000;

export interface MessageChatWindow {
  sentAt: number[];
  wakesAt: number[];
  newChatsAt: number[];
  steersAt: number[];
  /** Sends this chat made that have not been seen to start, at most one per
   *  target chat. It is what stops a supervisor from paying for the same report
   *  twice: the first send answered "not confirmed yet", and a second one would
   *  deliver it again. Cleared the moment the real delivery settles (see
   *  `awaitMessageChatDelivery`), and by the same hour cutoff as the counters. */
  unclaimed: { targetId: string; at: number }[];
}

export type MessageChatDeliveryResult =
  | DeliveryOutcome
  | { kind: 'unconfirmed'; why: 'timeout' | 'aborted' };

/** A refusal that may nevertheless have landed. Only a peer can report it: this
 *  window's own router either took the message or said it did not. A peer whose
 *  answer was lost after the bytes left cannot be told apart from one that
 *  queued the message and then died, so the caller keeps its counters and its
 *  cooldown and tells the sender not to resend. */
export interface UncertainDelivery {
  kind: 'refused';
  error: string;
  uncertain: true;
}

/** What any `deliver` port — the sidebar's router, or another window's route —
 *  may answer. */
export type DeliveryOutcome = ChatMessageDelivery | UncertainDelivery;

export interface MessageChatActionSidebar {
  /** The sidebar seam every action reads through: status and activity for all of
   *  them, the chat-cap preflight and `createConversation` for `new`,
   *  `setConversationModel` to pin a worker's model, `applyAutoTitle` to name it,
   *  and `recentExchanges` for `view`. Each is addressed by chat id, so none of
   *  them moves the active tab out from under the chat that is asking. */
  getHostFacade(): Pick<
    ForgeHostFacade,
    | 'status'
    | 'emitHostActivity'
    | 'chatCapBlockers'
    | 'createConversation'
    | 'setConversationModel'
    | 'applyAutoTitle'
    | 'recentExchanges'
    | 'clankerMode'
  >;
  deliverChatMessage(
    text: string,
    conversationId: string,
    steer?: boolean,
  ): Promise<ChatMessageDelivery>;
}

export interface MessageChatActionContext {
  sidebar: MessageChatActionSidebar;
  sender: ChatRef;
  chats: ChatRef[];
  selfId: string;
  window: MessageChatWindow;
  at: number;
  message: string;
  /** How many chats this sender may open in an hour, from
   *  `permissions.chats.new_chats_per_hour`; the schema default is the 2 above. */
  newChatsPerHour: number;
  /** For `new`: the model to pin the fresh chat to. The sender's own model unless
   *  the call named one, so a worker does not load a second engine. Absent when
   *  the sender's chat has no model of its own, leaving the window default. */
  pinModel?: string;
  signal?: AbortSignal;
  formatMessage: () => string;
  formatName: (chat: ChatRef) => string;
  refuse: (message: string) => string;
  emitActivity: (conversationId: string, text: string) => void;
  formatMirrorLine: (
    direction: 'in' | 'out',
    otherTitle: string,
    status: ChatMessageMirrorStatus,
    body: string,
  ) => string;
}

export function nextAllowedAt(times: number[]): number {
  return Math.min(...times) + HOUR_MS;
}

export function atText(at: number): string {
  return new Date(at).toISOString();
}

export function pruneMessageChatWindow(window: MessageChatWindow, now: number): void {
  const cutoff = now - HOUR_MS;
  window.sentAt = window.sentAt.filter((at) => at > cutoff);
  window.wakesAt = window.wakesAt.filter((at) => at > cutoff);
  window.newChatsAt = window.newChatsAt.filter((at) => at > cutoff);
  window.steersAt = window.steersAt.filter((at) => at > cutoff);
  window.unclaimed = window.unclaimed.filter((entry) => entry.at > cutoff);
}

/** One unconfirmed send per target chat, so a supervisor that cannot yet see its
 *  report start does not send it twice. Read from source: a send into a chat that
 *  is already busy is admitted as a tell at once (`deliverChatMessage`,
 *  `backgroundExitNotice.ts:179-181`), so an unconfirmed answer only ever comes
 *  from a send to an **idle** chat whose admission was held by
 *  `agentLoop.waitForCancelledTurns()` (`SendPipeline.ts:145`,
 *  `TurnLifecycle.ts:194-198`) — a cancellation settling in some other chat, not a
 *  compaction. The mark dies with the hour, so a stuck attempt cannot block a
 *  chat forever. */
export function unclaimedSendRefusal(
  window: MessageChatWindow,
  targetId: string,
  name: string,
): string | undefined {
  const earlier = window.unclaimed.find((entry) => entry.targetId === targetId);
  if (!earlier) return undefined;
  return (
    `Error: the earlier send has not started yet. ${name} still holds the message ` +
    `you sent at ${atText(earlier.at)}; it is counted as delivered until it starts ` +
    `or this hour expires. Do not send it again — read the chat with \`view\` or \`list\`.`
  );
}

/** Remember that this sender's last message to `targetId` has not been seen to
 *  start. Only one entry per target: a third send cannot add a fourth message. */
export function markUnclaimedSend(window: MessageChatWindow, targetId: string, at: number): void {
  if (window.unclaimed.some((entry) => entry.targetId === targetId)) return;
  window.unclaimed.push({ targetId, at });
}

/** The attempt is no longer outstanding: the real delivery settled after the 20 s
 *  guess, or the hour ran out. A retry is allowed again from here. */
export function clearUnclaimedSend(window: MessageChatWindow, targetId: string): void {
  const index = window.unclaimed.findIndex((entry) => entry.targetId === targetId);
  if (index >= 0) window.unclaimed.splice(index, 1);
}

export function messageChatSendLimit(window: MessageChatWindow, idle: boolean): string | undefined {
  if (window.sentAt.length >= MESSAGE_CHAT_SENDS_PER_HOUR) {
    return `Error: the ${MESSAGE_CHAT_SENDS_PER_HOUR}-send-per-hour limit for this chat was reached; the next send is allowed at ${atText(nextAllowedAt(window.sentAt))}.`;
  }
  if (idle && window.wakesAt.length >= MESSAGE_CHAT_IDLE_WAKES_PER_HOUR) {
    return `Error: the ${MESSAGE_CHAT_IDLE_WAKES_PER_HOUR}-idle-chat-wake-per-hour limit for this chat was reached; the next idle wake is allowed at ${atText(nextAllowedAt(window.wakesAt))}.`;
  }
  return undefined;
}

export function awaitMessageChatDelivery(
  delivery: Promise<DeliveryOutcome>,
  signal: AbortSignal | undefined,
  /** Called only when the real delivery settles after we have already answered
   *  "unconfirmed". The 20 s wait is a guess about admission; this is the fact, and
   *  it is what makes a refused duplicate allowed again — the caller clears its
   *  unclaimed mark here. */
  onLateSettle?: (result: DeliveryOutcome) => void,
): Promise<MessageChatDeliveryResult> {
  return new Promise((resolve, reject) => {
    // True once we have answered without seeing the delivery. Every later
    // settlement of the real promise is then a late fact, not a second answer.
    let answeredEarly = false;
    const timer = setTimeout(() => {
      answeredEarly = true;
      finish({ kind: 'unconfirmed', why: 'timeout' });
    }, MESSAGE_CHAT_DELIVERY_CONFIRM_MS);
    const onAbort = (): void => {
      answeredEarly = true;
      finish({ kind: 'unconfirmed', why: 'aborted' });
    };
    function finish(result: MessageChatDeliveryResult): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }
    if (signal?.aborted) {
      answeredEarly = true;
      finish({ kind: 'unconfirmed', why: 'aborted' });
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    delivery.then(
      (value: DeliveryOutcome) => {
        if (answeredEarly) onLateSettle?.(value);
        else finish(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const message = error instanceof Error ? error.message : String(error);
        if (answeredEarly) onLateSettle?.({ kind: 'refused', error: message });
        else reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function commitSend(window: MessageChatWindow, at: number, idleWake: boolean): void {
  window.sentAt.push(at);
  if (idleWake) window.wakesAt.push(at);
}

function rollbackSend(window: MessageChatWindow, at: number, idleWake: boolean): void {
  const sentIndex = window.sentAt.lastIndexOf(at);
  if (sentIndex >= 0) window.sentAt.splice(sentIndex, 1);
  if (idleWake) {
    const wakeIndex = window.wakesAt.lastIndexOf(at);
    if (wakeIndex >= 0) window.wakesAt.splice(wakeIndex, 1);
  }
}

function deliverStatus(result: MessageChatDeliveryResult): ChatMessageMirrorStatus {
  if (result.kind === 'tell') return 'tell';
  if (result.kind === 'turn') return 'turn';
  if (result.kind === 'unconfirmed') return 'unconfirmed';
  return undefined;
}

export function emitDeliveryActivity(
  input: MessageChatActionContext,
  target: ChatRef,
  result: MessageChatDeliveryResult,
  steering: boolean,
): void {
  const body = clipMirroredPrompt(input.message);
  const status = steering ? 'steer' : deliverStatus(result);
  input.emitActivity(target.id, input.formatMirrorLine('in', input.sender.title, undefined, body));
  input.emitActivity(input.sender.id, input.formatMirrorLine('out', target.title, status, body));
}

/** Count an accepted action against its caps. `idleWake`, `newChat` and `steer`
 *  say which of the three extra caps this call also burned, so a refund below
 *  takes back exactly what this one added. */
export function recordAction(
  window: MessageChatWindow,
  at: number,
  idleWake: boolean,
  newChat: boolean,
  steer: boolean,
): void {
  commitSend(window, at, idleWake);
  if (newChat) window.newChatsAt.push(at);
  if (steer) window.steersAt.push(at);
}

export function rollbackAction(
  window: MessageChatWindow,
  at: number,
  idleWake: boolean,
  newChat: boolean,
  steer: boolean,
): void {
  rollbackSend(window, at, idleWake);
  if (newChat) {
    const index = window.newChatsAt.lastIndexOf(at);
    if (index >= 0) window.newChatsAt.splice(index, 1);
  }
  if (steer) {
    const index = window.steersAt.lastIndexOf(at);
    if (index >= 0) window.steersAt.splice(index, 1);
  }
}

/** The line the sender reads. `openedOn` is what a `new` chat was pinned to:
 *  without it in the sentence, the sender cannot tell whether its worker will
 *  reuse the engine already loaded or start a second one. */
export function formatDeliveryResult(
  name: string,
  result: MessageChatDeliveryResult,
  action: 'new' | 'steer',
  openedOn?: string,
): string {
  if (action === 'steer' && result.kind === 'tell') {
    return `Steering message delivered to ${name}: it reads this at its next round, and its turn is interrupted only if it is generating one.`;
  }
  const lead = openedOn ? `Opened ${name} on ${openedOn}` : `Delivered to ${name}`;
  if (result.kind === 'tell') return `${lead} (running): it reads this at its next tool round.`;
  if (result.kind === 'turn') return `${lead} (idle): a turn started there.`;
  if (result.kind === 'refused') {
    return `Error: ${name} did not accept the message: ${result.error} Nothing was delivered; retry later or pick another chat.`;
  }
  return `Sent to ${name}, but its turn had not started after ${result.why === 'timeout' ? `${MESSAGE_CHAT_DELIVERY_CONFIRM_MS / 1000} s` : 'this turn was stopped'}; it may still start. Do not resend; check with \`list\` later.`;
}

/** Draw one activity line on a chat's transcript. Never allowed to throw: the
 *  line is decoration on a delivery that already happened, and a failure here
 *  would reach the caller as a failed send. Shared because a local action and a
 *  peer action draw the same line in the sender's own transcript. */
export function emitPromptActivity(
  facade: Pick<ForgeHostFacade, 'emitHostActivity'> | undefined,
  conversationId: string,
  text: string,
): void {
  try {
    facade?.emitHostActivity?.({ kind: 'prompt', conversationId, text });
  } catch (error) {
    try {
      logger.warn(
        `message_chat: failed to emit prompt activity for ${conversationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Logging failure must not change the result of an already-delivered message.
    }
  }
}
