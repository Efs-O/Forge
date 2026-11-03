import type { ForgeHostFacade, ForgeHostStatus } from '../sidebar/ForgeHostFacade';
import type { ForgeConfig } from '../config/types';
import { resolvesToConfiguredModel } from '../config/modelReferences';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';
import { logger } from '../util/logger';
import {
  actionFlags,
  actionList,
  MESSAGE_CHAT_MESSAGE_MAX_CHARS,
  MESSAGE_CHAT_MESSAGE_PART_CHARS,
  messageChatDefinition,
  requestSchema,
  requestShapeSchema,
} from './messageChatSchema';
import {
  awaitMessageChatDelivery,
  clearUnclaimedSend,
  createMessageChatActions,
  markUnclaimedSend,
  MESSAGE_CHAT_DELIVERY_CONFIRM_MS,
  MESSAGE_CHAT_NEW_CHATS_PER_HOUR_DEFAULT,
  messageChatSendLimit,
  pruneMessageChatWindow,
  unclaimedSendRefusal,
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
  type ChatReferenceResolution,
} from './chatMessageResolver';

/** The sidebar seam the tool dispatches through, re-exported so the tests and
 *  the wiring name it from the tool that uses it. */
export type MessageChatSidebar = MessageChatActionSidebar;

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

function closedChatRefs(status: ForgeHostStatus): ChatRef[] {
  return status.conversations
    .filter((conversation) => conversation.archived)
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      // No tab, so no position: the `#N` tier never resolves a closed chat.
      position: 0,
      running: false,
      closed: true,
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
  // A closed chat has no tab number to name it by, so `view`'s header quotes its
  // title alone and `renderChatView` marks the read `closed`.
  return chat.closed ? quoteTitle(chat.title) : `#${chat.position} ${quoteTitle(chat.title)}`;
}

/** Which chat `view` reads. An open chat always wins: only a reference that
 *  named one chat and matched nothing among the open tabs is tried again
 *  against the closed chats, so a supervisor can read back a worker that closed
 *  its tab while `send` and `steer` still refuse it. Every refusal comes back
 *  fully formatted, because a closed-chat ambiguity lists its own candidates
 *  rather than the open tabs. */
function resolveViewTarget(
  ref: string | undefined,
  chats: ChatRef[],
  closed: ChatRef[],
  selfId: string,
): { ok: true; chat: ChatRef } | { ok: false; refusal: string } {
  const open = resolveChatReference(ref, chats, selfId);
  if (open.ok) return open;
  // Ambiguous, self-matched, or an omitted reference: the open chats already
  // answered it, and a closed chat must never win over an open one.
  if (open.reasonCode !== 'unmatched' || closed.length === 0) {
    return { ok: false, refusal: listRefusal(`Error: ${open.reason}`, chats, selfId) };
  }
  const history = resolveChatReference(ref, closed, selfId);
  if (history.ok) return { ok: true, chat: history.chat };
  // Two closed chats match the same words: name both, never pick one. The
  // reason already lists them by title and id, so the open-tab list would only
  // add chats this read cannot reach. (`unmatched` lists every closed chat as
  // candidates, so the code, not the count, is what tells the two apart.)
  if (history.reasonCode === 'ambiguous') return { ok: false, refusal: `Error: ${history.reason}` };
  // Neither an open tab nor recent history — an overflow-archive chat, or no
  // such chat at all — keeps the refusal it had before the fallback existed.
  return { ok: false, refusal: listRefusal(`Error: ${open.reason}`, chats, selfId) };
}

/** The one sentence a `send` or `steer` earns when the reference matched a chat
 *  that is closed rather than open: the caller learns its worker is still
 *  readable instead of guessing the chat is gone. Nothing else about those
 *  actions changes — a closed chat is never delivered to, queued or woken. */
function closedChatHint(
  resolution: ChatReferenceResolution,
  ref: string | undefined,
  closed: ChatRef[],
  selfId: string,
): string {
  if (resolution.ok || resolution.reasonCode !== 'unmatched' || closed.length === 0) return '';
  return resolveChatReference(ref, closed, selfId).ok
    ? '\nThat chat is closed; `view` can still read it.'
    : '';
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
      window = { sentAt: [], wakesAt: [], newChatsAt: [], steersAt: [], unclaimed: [] };
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
    /** A send, a `new` chat or a `steer` lands in a DIFFERENT chat, possibly in
     *  another window, so the text leaves this chat's control. `autoApprove` is a
     *  claim about the tool's inputs, not about what this chat has read: in a chat
     *  that took in a page, `untrustedExitPolicy.ts` still asks the owner, because
     *  that page may have chosen the message. */
    reachesOut: 'cross_chat',
    approval: (args, gateContext) => {
      if (args['action'] !== 'steer' || !actionFlags(options.getConfig).steer) return undefined;
      const sidebar = options.getSidebar();
      if (!sidebar) return undefined;
      // Clanker is a chat's, so it is read for the chat that is sending: a chat the
      // owner armed may interrupt another chat without asking, and one they did not
      // arm still asks, whatever another tab in the same window is doing.
      const conversationId = gateContext?.conversationId;
      if (conversationId && sidebar.getHostFacade().clankerMode(conversationId)) {
        return undefined;
      }
      return {
        detail: 'Allow this chat to interrupt another chat and send it a steering message?',
        dangerous: true,
      };
    },
    handler: async (args, context?: ToolHandlerContext) => {
      // No `action` with a `message` means `send`. This is the audited slip (ten
      // calls refused for a missing `action` in seven chats, 2026-10-27), and
      // `send` is the least powerful action that takes a message: `new` creates
      // a chat and `steer` interrupts one, so neither is ever inferred here.
      // The inference happens in this tool's own parsing, ahead of the schema, so
      // `ToolRegistry.invalidArgs` cannot refuse the call for a field the tool is
      // about to fill in — which is why the schema requires nothing.
      const inferredSend =
        args['action'] === undefined &&
        typeof args['message'] === 'string' &&
        args['message'].length > 0;
      const effectiveArgs: Record<string, unknown> = inferredSend
        ? { ...args, action: 'send' }
        : args;
      if (effectiveArgs['action'] === undefined) {
        // Thrown rather than returned, so `ToolDispatch` prefixes `Error:` and
        // records the failure in the streak that can strip a model's tools: this
        // call replaced a thrown ZodError, so it must still count as a failure.
        throw new Error(
          'message_chat needs `action` ' +
            `(one of: ${actionList(actionFlags(options.getConfig)).join(', ')}) or a ` +
            '`message` to send. Call it with `action` set to `list` to see the chats.',
        );
      }
      // Said on every send-path result, so the session log shows the tool inferred
      // an action rather than the model having chosen one.
      const say = (result: string): string =>
        inferredSend ? `${result}\nNo \`action\` was given, so \`send\` was used.` : result;
      // The length refusal has to be actionable. "Shorten it and resend" gives a
      // model no target, and a worker's report is long by nature — one chat tried
      // a 5,495-character report five times and was refused every time. Parts are
      // counted against 10,000 rather than the 12,000 cap, so a part that is
      // re-measured by eye still fits, and one throw replaces five retries.
      const rawMessage = effectiveArgs['message'];
      if (typeof rawMessage === 'string' && rawMessage.length > MESSAGE_CHAT_MESSAGE_MAX_CHARS) {
        const parts = Math.ceil(rawMessage.length / MESSAGE_CHAT_MESSAGE_PART_CHARS);
        throw new Error(
          `message_chat message is ${rawMessage.length} characters; the limit is ` +
            `${MESSAGE_CHAT_MESSAGE_MAX_CHARS}. Send it as ${parts} ` +
            `${parts === 1 ? 'message' : 'messages'}.`,
        );
      }
      const draft = requestShapeSchema.parse(effectiveArgs);
      const flags = actionFlags(options.getConfig);
      if (draft.action === 'new' && !flags.newChat) {
        return 'Error: `new` is not enabled in this window.';
      }
      if (draft.action === 'steer' && !flags.steer) {
        return 'Error: `steer` is not enabled in this window.';
      }
      const parsed = requestSchema(flags).parse(effectiveArgs);
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
      // The closed chats in recent history: what `view` falls back to, and what
      // the send/steer refusals mention when a reference matched one of them.
      const closed = closedChatRefs(status);
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
      // `new_chats_per_hour` is the owner's dial on how many workers one chat may
      // open in an hour; the config default is the same 2 this tool used to
      // hard-code, so a window that sets nothing behaves exactly as before.
      const newChatsPerHour =
        options.getConfig?.().permissions?.chats?.new_chats_per_hour ??
        MESSAGE_CHAT_NEW_CHATS_PER_HOUR_DEFAULT;
      // What every action that touches another chat needs, assembled once: the
      // branches differ only in the message they send and the chat they aim it at.
      const baseContext = {
        sidebar,
        sender,
        chats,
        selfId,
        window,
        at,
        newChatsPerHour,
        ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
        formatName: formatChatName,
        refuse: (message: string) => listRefusal(message, chats, selfId),
        emitActivity: (id: string, text: string) => emitPromptActivity(hostFacade, id, text),
        formatMirrorLine: formatChatMirrorLine,
      };

      if (parsed.action === 'view') {
        const target = resolveViewTarget(parsed.to, chats, closed, selfId);
        if (!target.ok) return target.refusal;
        const name = formatChatName(target.chat);
        try {
          // A read, so it burns nothing: no send, no wake, no new-chat or steer
          // counter, and a supervisor can watch a worker as often as it has turns.
          return actions.view({
            ...baseContext,
            message: '',
            formatMessage: () => '',
            target: target.chat,
          });
        } catch (error) {
          return listRefusal(
            `Error: message_chat could not read ${name}: ${String(error)}.`,
            chats,
            selfId,
          );
        }
      }

      if (parsed.action === 'new') {
        const workerMessage = parsed.message ?? '';
        // The default is the model this chat is already on, not the window's
        // active model: a supervisor's worker should reuse the engine its
        // supervisor is talking through, and anything else loads a second one.
        let pinModel = sender.model;
        if (parsed.model !== undefined) {
          const config = options.getConfig?.();
          if (!config) {
            return listRefusal(
              "Error: message_chat cannot check a `model` name without the loaded config. Omit `model` to open the new chat on this chat's own model.",
              chats,
              selfId,
            );
          }
          // Checked before anything is opened, so a name that points at nothing
          // configured costs nothing: no chat, no counters, no second server.
          if (!resolvesToConfiguredModel(config, parsed.model)) {
            return listRefusal(
              `Error: "${parsed.model}" does not name a model in config.yaml (configured: ${config.models.map((model) => model.name).join(', ') || 'none'}). Nothing was created and no counter was used.`,
              chats,
              selfId,
            );
          }
          // Passed on as it was given, not as the base name it resolved to, so a
          // `model@profile` keeps its profile — the agent bus hands the same
          // strings to `setConversationModel` unchanged.
          pinModel = parsed.model;
        }
        const actionContext: MessageChatActionContext = {
          ...baseContext,
          message: workerMessage,
          ...(pinModel ? { pinModel } : {}),
          formatMessage: () => messageFrom(sender, chats, workerMessage),
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
        if (!resolution.ok)
          return listRefusal(
            `Error: ${resolution.reason}${closedChatHint(resolution, parsed.to, closed, selfId)}`,
            chats,
            selfId,
          );
        const actionContext: MessageChatActionContext = {
          ...baseContext,
          message: steerMessage,
          formatMessage: () => messageFrom(sender, chats, steerMessage),
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
      if (!resolution.ok)
        return say(
          listRefusal(
            `Error: ${resolution.reason}${closedChatHint(resolution, parsed.to, closed, selfId)}`,
            chats,
            selfId,
          ),
        );
      const target = resolution.chat;
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
          sidebar.deliverChatMessage(messageFrom(sender, chats, parsed.message), target.id),
          context.abortSignal,
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
      // And it is remembered as outstanding, so while it is the same chat cannot
      // send to the same target again and pay for the report twice. The real
      // delivery settling late clears this, so a retry is allowed once it starts
      // or is refused; otherwise the mark dies with the hour.
      if (delivery.kind === 'unconfirmed') markUnclaimedSend(window, target.id, at);
      if (delivery.kind === 'tell')
        return say(`Delivered to ${name} (running): it reads this at its next tool round.`);
      if (delivery.kind === 'turn')
        return say(`Delivered to ${name} (idle): a turn started there.`);
      return say(
        `Sent to ${name}, but its turn had not started after ${delivery.why === 'timeout' ? `${MESSAGE_CHAT_DELIVERY_CONFIRM_MS / 1000} s` : 'this turn was stopped'}; it may still start. Do not resend; check with \`list\` later.`,
      );
    },
  };
}
