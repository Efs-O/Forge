import { z } from 'zod';
import type { ChatMessageDelivery } from '../sidebar/backgroundExitNotice';
import type { ForgeHostFacade, ForgeHostStatus } from '../sidebar/ForgeHostFacade';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';
import {
  formatChatId,
  formatChatList,
  resolveChatReference,
  type ChatRef,
} from './chatMessageResolver';

const requestSchema = z
  .object({
    action: z.enum(['list', 'send']),
    to: z.string().min(1).max(200).optional(),
    message: z.string().min(1).max(4000).optional(),
  })
  .strict();

const HOUR_MS = 60 * 60 * 1000;
const SENDS_PER_HOUR = 30;
const IDLE_WAKES_PER_HOUR = 6;
/** How long a send waits for the target to admit its turn before reporting "not confirmed". */
const DELIVERY_CONFIRM_MS = 20_000;

interface SendWindow {
  sentAt: number[];
  wakesAt: number[];
}

export interface MessageChatSidebar {
  getHostFacade(): Pick<ForgeHostFacade, 'status'>;
  /** The shared prompt router: a tell for a busy chat, a visible turn for an idle one. */
  deliverChatMessage(text: string, conversationId: string): Promise<ChatMessageDelivery>;
}

function chatRefs(status: ForgeHostStatus): ChatRef[] {
  const open = status.conversations.filter((conversation) => !conversation.archived);
  const runningIds = new Set(status.streamingConversationIds);
  const reservedIds = new Set(status.requestChains.map((chain) => chain.conversationId));
  return open.map((conversation, index) => ({
    id: conversation.id,
    title: conversation.title,
    position: index + 1,
    running: runningIds.has(conversation.id) || reservedIds.has(conversation.id),
    ...(conversation.activeModel ? { model: conversation.activeModel } : {}),
  }));
}

function listRefusal(message: string, chats: ChatRef[], selfId: string): string {
  return `${message}\n\n${formatChatList(chats, selfId)}`;
}

function nextAllowedText(at: number): string {
  return new Date(at).toISOString();
}

function nextAllowedAt(times: number[]): number {
  return Math.min(...times) + HOUR_MS;
}

function prune(window: SendWindow, now: number): void {
  const cutoff = now - HOUR_MS;
  window.sentAt = window.sentAt.filter((at) => at > cutoff);
  window.wakesAt = window.wakesAt.filter((at) => at > cutoff);
}

type DeliveryResult = ChatMessageDelivery | { kind: 'unconfirmed'; why: 'timeout' | 'aborted' };

/** Bounded wait: a turn admission can wait on cancelled turns, possibly this caller's own. */
function awaitDelivery(
  delivery: Promise<ChatMessageDelivery>,
  signal: AbortSignal | undefined,
): Promise<DeliveryResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish({ kind: 'unconfirmed', why: 'timeout' }),
      DELIVERY_CONFIRM_MS,
    );
    const onAbort = (): void => finish({ kind: 'unconfirmed', why: 'aborted' });
    function finish(result: DeliveryResult): void {
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

function messageFrom(sender: ChatRef, chats: ChatRef[], text: string): string {
  const senderId = formatChatId(sender.id, chats);
  const quotedTitle = JSON.stringify(sender.title);
  const quotedId = JSON.stringify(senderId);
  return [
    `[message_chat from #${sender.position} ${quotedTitle} (id ${senderId})]`,
    text,
    '',
    `(Answer with message_chat to ${quotedId} only if a reply is needed; do not reply just to acknowledge.)`,
  ].join('\n');
}

export function makeMessageChatTool(options: {
  getSidebar: () => MessageChatSidebar | undefined;
  now?: () => number;
}): RegisteredTool {
  const windows = new Map<string, SendWindow>();
  const now = options.now ?? Date.now;

  return {
    definition: {
      type: 'function',
      function: {
        name: 'message_chat',
        description:
          "Message another Forge chat in this window. `send`: `to` is a chat id, `#N` from `list`, or words from the chat's title; omit `to` to reach the other chat when exactly one other chat is running (or open). No `list` needed first. A running chat reads it at its next tool round; an idle chat starts a turn. Replies arrive the same way. `list`: show the chats.",
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'send'] },
            to: { type: 'string', minLength: 1, maxLength: 200 },
            message: { type: 'string', minLength: 1, maxLength: 4000 },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delegate',
    // Sending a bounded text message is intentional and must not prompt once per send.
    autoApprove: true,
    handler: async (args, context?: ToolHandlerContext) => {
      const parsed = requestSchema.parse(args);
      let sidebar: MessageChatSidebar | undefined;
      try {
        sidebar = options.getSidebar();
      } catch (error) {
        return `Error: message_chat could not reach the sidebar: ${String(error)}. Open the Forge sidebar and retry.`;
      }
      if (!sidebar) {
        return 'Error: message_chat needs the Forge sidebar to be open. Open it and retry.';
      }

      let status: ForgeHostStatus;
      try {
        status = sidebar.getHostFacade().status();
      } catch (error) {
        return `Error: message_chat could not read the open chats: ${String(error)}. Reopen the Forge sidebar and retry.`;
      }
      const chats = chatRefs(status);
      const selfId = context?.conversationId;
      if (!selfId) {
        return listRefusal('Error: message_chat requires an active chat turn.', chats, '');
      }
      const sender = chats.find((chat) => chat.id === selfId);
      if (!sender) {
        return listRefusal(
          'Error: the chat running message_chat is no longer open. Retry from an open chat.',
          chats,
          selfId,
        );
      }

      if (parsed.action === 'list') {
        if (parsed.to !== undefined || parsed.message !== undefined) {
          return listRefusal(
            'Error: `list` does not take `to` or `message`; call it with only `action`.',
            chats,
            selfId,
          );
        }
        return formatChatList(chats, selfId);
      }

      if (parsed.message === undefined) {
        return listRefusal(
          'Error: `send` requires `message`. Pass `message` with the text to deliver.',
          chats,
          selfId,
        );
      }

      const resolution = resolveChatReference(parsed.to, chats, selfId);
      if (!resolution.ok) return listRefusal(`Error: ${resolution.reason}`, chats, selfId);
      const target = resolution.chat;
      const at = now();
      let window = windows.get(selfId);
      if (!window) {
        window = { sentAt: [], wakesAt: [] };
        windows.set(selfId, window);
      }
      prune(window, at);
      if (window.sentAt.length >= SENDS_PER_HOUR) {
        return listRefusal(
          `Error: the ${SENDS_PER_HOUR}-send-per-hour limit for this chat was reached; the next send is allowed at ${nextAllowedText(nextAllowedAt(window.sentAt))}.`,
          chats,
          selfId,
        );
      }
      if (!target.running && window.wakesAt.length >= IDLE_WAKES_PER_HOUR) {
        return listRefusal(
          `Error: the ${IDLE_WAKES_PER_HOUR}-idle-chat-wake-per-hour limit for this chat was reached; the next idle wake is allowed at ${nextAllowedText(nextAllowedAt(window.wakesAt))}.`,
          chats,
          selfId,
        );
      }

      let delivery: DeliveryResult;
      try {
        delivery = await awaitDelivery(
          sidebar.deliverChatMessage(messageFrom(sender, chats, parsed.message), target.id),
          context.abortSignal,
        );
      } catch (error) {
        return listRefusal(
          `Error: message_chat could not route the message: ${String(error)}. Retry when the sidebar is available.`,
          chats,
          selfId,
        );
      }
      const name = `#${target.position} ${JSON.stringify(target.title)}`;
      if (delivery.kind === 'refused') {
        return listRefusal(
          `Error: ${name} did not accept the message: ${delivery.error} Nothing was delivered; retry later or pick another chat.`,
          chats,
          selfId,
        );
      }
      // An unconfirmed send may still start, so it counts against both caps.
      window.sentAt.push(at);
      if (delivery.kind !== 'tell') window.wakesAt.push(at);
      if (delivery.kind === 'tell')
        return `Delivered to ${name} (running): it reads this at its next tool round.`;
      if (delivery.kind === 'turn') return `Delivered to ${name} (idle): a turn started there.`;
      return `Sent to ${name}, but its turn had not started after ${delivery.why === 'timeout' ? `${DELIVERY_CONFIRM_MS / 1000} s` : 'this turn was stopped'}; it may still start. Do not resend; check with \`list\` later.`;
    },
  };
}
