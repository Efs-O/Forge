import type { ForgeHostFacade, ForgeHostStatus } from '../sidebar/ForgeHostFacade';
import type { ChatMessageDelivery } from '../sidebar/backgroundExitNotice';
import type { ChatMessageMirrorStatus } from '../sidebar/chatMessageText';
import { clipMirroredPrompt } from '../sidebar/turnMirrorWiring';
import type { ChatRef } from './chatMessageResolver';

const HOUR_MS = 60 * 60 * 1000;
const MESSAGE_CHAT_SENDS_PER_HOUR = 30;
const MESSAGE_CHAT_IDLE_WAKES_PER_HOUR = 6;
const MESSAGE_CHAT_NEW_CHATS_PER_HOUR = 2;
const MESSAGE_CHAT_STEERS_PER_HOUR = 3;
const MESSAGE_CHAT_STEER_TARGET_GAP_MS = 2 * 60 * 1000;
export const MESSAGE_CHAT_DELIVERY_CONFIRM_MS = 20_000;

export interface MessageChatWindow {
  sentAt: number[];
  wakesAt: number[];
  newChatsAt: number[];
  steersAt: number[];
}

export type MessageChatDeliveryResult =
  | ChatMessageDelivery
  | { kind: 'unconfirmed'; why: 'timeout' | 'aborted' };

export interface MessageChatActionSidebar {
  getHostFacade(): Pick<
    ForgeHostFacade,
    'status' | 'emitHostActivity' | 'chatCapBlockers' | 'createConversation' | 'clankerMode'
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

interface SteerContext extends MessageChatActionContext {
  target: ChatRef;
  to?: string;
}

interface SteerOrigin {
  senderId: string;
  baseEpoch?: number;
}

function nextAllowedAt(times: number[]): number {
  return Math.min(...times) + HOUR_MS;
}

function atText(at: number): string {
  return new Date(at).toISOString();
}

export function pruneMessageChatWindow(window: MessageChatWindow, now: number): void {
  const cutoff = now - HOUR_MS;
  window.sentAt = window.sentAt.filter((at) => at > cutoff);
  window.wakesAt = window.wakesAt.filter((at) => at > cutoff);
  window.newChatsAt = window.newChatsAt.filter((at) => at > cutoff);
  window.steersAt = window.steersAt.filter((at) => at > cutoff);
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
  delivery: Promise<ChatMessageDelivery>,
  signal: AbortSignal | undefined,
): Promise<MessageChatDeliveryResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish({ kind: 'unconfirmed', why: 'timeout' }),
      MESSAGE_CHAT_DELIVERY_CONFIRM_MS,
    );
    const onAbort = (): void => finish({ kind: 'unconfirmed', why: 'aborted' });
    function finish(result: MessageChatDeliveryResult): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }
    if (signal?.aborted) return finish({ kind: 'unconfirmed', why: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
    delivery.then(finish, (error: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
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

function emitDeliveryActivity(
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

function recordAction(
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

function rollbackAction(
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

function formatDeliveryResult(
  name: string,
  result: MessageChatDeliveryResult,
  action: 'new' | 'steer',
): string {
  if (action === 'steer' && result.kind === 'tell') {
    return `Steering message delivered to ${name}: it reads this at its next round, and its turn is interrupted only if it is generating one.`;
  }
  if (result.kind === 'tell')
    return `Delivered to ${name} (running): it reads this at its next tool round.`;
  if (result.kind === 'turn') return `Delivered to ${name} (idle): a turn started there.`;
  if (result.kind === 'refused') {
    return `Error: ${name} did not accept the message: ${result.error} Nothing was delivered; retry later or pick another chat.`;
  }
  return `Sent to ${name}, but its turn had not started after ${result.why === 'timeout' ? `${MESSAGE_CHAT_DELIVERY_CONFIRM_MS / 1000} s` : 'this turn was stopped'}; it may still start. Do not resend; check with \`list\` later.`;
}

export function createMessageChatActions(): {
  createNewChat(input: MessageChatActionContext): Promise<string>;
  steer(input: SteerContext): Promise<string>;
} {
  const lastSteerByTarget = new Map<string, number>();
  const steerOrigins = new Map<string, SteerOrigin>();

  return {
    createNewChat: async (input) => {
      const { sidebar, window, at } = input;
      pruneMessageChatWindow(window, at);
      const sendLimit = messageChatSendLimit(window, true);
      if (sendLimit) return input.refuse(sendLimit);
      if (window.newChatsAt.length >= MESSAGE_CHAT_NEW_CHATS_PER_HOUR) {
        return input.refuse(
          `Error: the ${MESSAGE_CHAT_NEW_CHATS_PER_HOUR}-new-chat-per-hour limit for this chat was reached; the next new chat is allowed at ${atText(nextAllowedAt(window.newChatsAt))}.`,
        );
      }

      let facade: ReturnType<MessageChatActionSidebar['getHostFacade']>;
      try {
        facade = sidebar.getHostFacade();
        const blockers = facade.chatCapBlockers({ activate: false });
        if (blockers.length > 0) {
          return input.refuse(`Error: a new chat cannot be opened yet:\n${blockers.join('\n')}`);
        }
      } catch (error) {
        return input.refuse(`Error: message_chat could not check the chat cap: ${String(error)}.`);
      }

      recordAction(window, at, true, true, false);
      let created: Awaited<ReturnType<typeof facade.createConversation>>;
      try {
        created = await facade.createConversation({ activate: false });
      } catch (error) {
        rollbackAction(window, at, true, true, false);
        return input.refuse(`Error: message_chat could not create a new chat: ${String(error)}.`);
      }

      const target: ChatRef = {
        id: created.id,
        title: created.title,
        position: input.chats.length + 1,
        running: false,
        ...(created.activeModel ? { model: created.activeModel } : {}),
      };
      let result: MessageChatDeliveryResult;
      try {
        result = await awaitMessageChatDelivery(
          sidebar.deliverChatMessage(input.formatMessage(), target.id),
          input.signal,
        );
      } catch (error) {
        rollbackAction(window, at, true, true, false);
        return input.refuse(
          `Error: message_chat could not route the first message: ${String(error)}. The empty chat ${input.formatName(target)} remains open; you can close it.`,
        );
      }
      if (result.kind === 'refused') {
        rollbackAction(window, at, true, true, false);
        return input.refuse(
          `Error: ${input.formatName(target)} did not accept the first message: ${result.error} Nothing was delivered; the empty chat remains open and can be closed.`,
        );
      }

      emitDeliveryActivity(input, target, result, false);
      return formatDeliveryResult(input.formatName(target), result, 'new');
    },
    steer: async (input) => {
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
        if (
          origin.baseEpoch === undefined ||
          epoch === undefined ||
          epoch <= origin.baseEpoch + 1
        ) {
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
      let result: MessageChatDeliveryResult;
      try {
        result = await awaitMessageChatDelivery(
          sidebar.deliverChatMessage(input.formatMessage(), target.id, target.running),
          input.signal,
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
      return formatDeliveryResult(input.formatName(target), result, 'steer');
    },
  };
}
