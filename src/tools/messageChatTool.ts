import { z } from 'zod';
import type { ForgeHostFacade, ForgeHostStatus } from '../sidebar/ForgeHostFacade';
import type { ForgeConfig } from '../config/types';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';
import { logger } from '../util/logger';
import {
  awaitMessageChatDelivery,
  createMessageChatActions,
  MESSAGE_CHAT_DELIVERY_CONFIRM_MS,
  messageChatSendLimit,
  pruneMessageChatWindow,
  type MessageChatActionContext,
  type MessageChatActionSidebar,
  type MessageChatWindow,
  type MessageChatDeliveryResult,
} from './messageChatActions';
import { clipMirroredPrompt } from '../sidebar/turnMirrorWiring';
import { formatChatMessage, formatChatMirrorLine, quoteTitle } from '../sidebar/chatMessageText';
import {
  formatChatId,
  formatChatList,
  resolveChatReference,
  type ChatRef,
} from './chatMessageResolver';

const requestShapeSchema = z
  .object({
    action: z.string().min(1),
    to: z.string().min(1).max(200).optional(),
    message: z.string().min(1).max(4000).optional(),
  })
  .strict();

interface MessageChatActionFlags {
  newChat: boolean;
  steer: boolean;
}

export type MessageChatSidebar = MessageChatActionSidebar;

function actionFlags(getConfig: (() => ForgeConfig) | undefined): MessageChatActionFlags {
  const permissions = getConfig?.().permissions?.chats;
  return { newChat: permissions?.new_chat ?? false, steer: permissions?.steer ?? false };
}

function requestSchema(flags: MessageChatActionFlags) {
  const actions = new Set([
    'list',
    'send',
    ...(flags.newChat ? ['new'] : []),
    ...(flags.steer ? ['steer'] : []),
  ]);
  return requestShapeSchema.superRefine((request, context) => {
    if (!actions.has(request.action)) {
      context.addIssue({ code: 'custom', path: ['action'], message: 'Action is not available.' });
    }
    if (request.action === 'new' && request.to !== undefined) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'new does not take to.' });
    }
    if ((request.action === 'new' || request.action === 'steer') && request.message === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: `${request.action} requires message.`,
      });
    }
  });
}

function messageChatDefinition(flags: MessageChatActionFlags): RegisteredTool['definition'] {
  const actions = [
    'list',
    'send',
    ...(flags.newChat ? ['new'] : []),
    ...(flags.steer ? ['steer'] : []),
  ];
  const additions = [
    flags.newChat
      ? '`new`: create a fresh chat with the window default title and send its first message; a title cannot be set here.'
      : '',
    flags.steer
      ? '`steer`: send a message to a chat, interrupting its active turn when it is busy; an idle chat starts a turn.'
      : '',
  ].filter(Boolean);
  return {
    type: 'function',
    function: {
      name: 'message_chat',
      description:
        "Message another Forge chat in this window. `send`: `to` is a chat id, `#N` from `list`, or words from the chat's title; omit `to` to reach the other chat when exactly one other chat is running (or open). No `list` needed first. A running chat reads it at its next tool round; an idle chat starts a turn. Replies arrive the same way. `list`: show the chats." +
        (additions.length > 0 ? ` ${additions.join(' ')}` : ''),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: actions },
          to: { type: 'string', minLength: 1, maxLength: 200 },
          message: {
            type: 'string',
            minLength: 1,
            maxLength: 4000,
            description:
              "Write it as you would to a coworker: first person, call the other chat 'you', no formalities, no reports about yourself in the third person.",
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  };
}

function emitPromptActivity(
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

function messageFrom(sender: ChatRef, chats: ChatRef[], text: string): string {
  const senderId = formatChatId(sender.id, chats);
  return formatChatMessage(sender.title, senderId, text);
}

function formatChatName(chat: ChatRef): string {
  return `#${chat.position} ${quoteTitle(chat.title)}`;
}

export function makeMessageChatTool(options: {
  getSidebar: () => MessageChatSidebar | undefined;
  getConfig?: () => ForgeConfig;
  now?: () => number;
}): RegisteredTool {
  const windows = new Map<string, MessageChatWindow>();
  const now = options.now ?? Date.now;
  const actions = createMessageChatActions();
  const windowFor = (senderId: string): MessageChatWindow => {
    let window = windows.get(senderId);
    if (!window) {
      window = { sentAt: [], wakesAt: [], newChatsAt: [], steersAt: [] };
      windows.set(senderId, window);
    }
    return window;
  };

  return {
    definition: messageChatDefinition({ newChat: false, steer: false }),
    describe: () => messageChatDefinition(actionFlags(options.getConfig)),
    permission: 'delegate',
    // Sending a bounded text message is intentional and must not prompt once per send.
    autoApprove: true,
    approval: (args) => {
      if (args['action'] !== 'steer' || !actionFlags(options.getConfig).steer) return undefined;
      const sidebar = options.getSidebar();
      if (!sidebar || sidebar.getHostFacade().clankerMode()) return undefined;
      return {
        detail: 'Allow this chat to interrupt another chat and send it a steering message?',
        dangerous: true,
      };
    },
    handler: async (args, context?: ToolHandlerContext) => {
      const draft = requestShapeSchema.parse(args);
      const flags = actionFlags(options.getConfig);
      if (draft.action === 'new' && !flags.newChat) {
        return 'Error: `new` is not enabled in this window.';
      }
      if (draft.action === 'steer' && !flags.steer) {
        return 'Error: `steer` is not enabled in this window.';
      }
      const parsed = requestSchema(flags).parse(args);
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
      let hostFacade: ReturnType<MessageChatSidebar['getHostFacade']>;
      try {
        hostFacade = sidebar.getHostFacade();
        status = hostFacade.status();
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

      const window = windowFor(selfId);
      const at = now();
      pruneMessageChatWindow(window, at);
      if (parsed.action === 'new') {
        const actionContext: MessageChatActionContext = {
          sidebar,
          sender,
          chats,
          selfId,
          window,
          at,
          message: parsed.message ?? '',
          ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
          formatMessage: () => messageFrom(sender, chats, parsed.message ?? ''),
          formatName: formatChatName,
          refuse: (message) => listRefusal(message, chats, selfId),
          emitActivity: (id, text) => emitPromptActivity(hostFacade, id, text),
          formatMirrorLine: formatChatMirrorLine,
        };
        return actions.createNewChat(actionContext);
      }

      if (parsed.action === 'steer') {
        if (parsed.message === undefined) {
          return listRefusal(
            'Error: `steer` requires `message`. Pass `message` with the text to deliver.',
            chats,
            selfId,
          );
        }
        const steerMessage = parsed.message;
        const resolution = resolveChatReference(parsed.to, chats, selfId);
        if (!resolution.ok) return listRefusal(`Error: ${resolution.reason}`, chats, selfId);
        const actionContext: MessageChatActionContext = {
          sidebar,
          sender,
          chats,
          selfId,
          window,
          at,
          message: steerMessage,
          ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
          formatMessage: () => messageFrom(sender, chats, steerMessage),
          formatName: formatChatName,
          refuse: (message) => listRefusal(message, chats, selfId),
          emitActivity: (id, text) => emitPromptActivity(hostFacade, id, text),
          formatMirrorLine: formatChatMirrorLine,
        };
        return actions.steer({
          ...actionContext,
          target: resolution.chat,
          ...(parsed.to ? { to: parsed.to } : {}),
        });
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
      const sendLimit = messageChatSendLimit(window, !target.running);
      if (sendLimit) return listRefusal(sendLimit, chats, selfId);

      let delivery: MessageChatDeliveryResult;
      try {
        delivery = await awaitMessageChatDelivery(
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
      const name = formatChatName(target);
      if (delivery.kind === 'refused') {
        return listRefusal(
          `Error: ${name} did not accept the message: ${delivery.error} Nothing was delivered; retry later or pick another chat.`,
          chats,
          selfId,
        );
      }
      const body = clipMirroredPrompt(parsed.message);
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
      if (delivery.kind === 'tell')
        return `Delivered to ${name} (running): it reads this at its next tool round.`;
      if (delivery.kind === 'turn') return `Delivered to ${name} (idle): a turn started there.`;
      return `Sent to ${name}, but its turn had not started after ${delivery.why === 'timeout' ? `${MESSAGE_CHAT_DELIVERY_CONFIRM_MS / 1000} s` : 'this turn was stopped'}; it may still start. Do not resend; check with \`list\` later.`;
    },
  };
}
