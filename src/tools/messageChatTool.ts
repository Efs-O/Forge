import type { ForgeHostStatus } from '../sidebar/ForgeHostFacade';
import type { ForgeConfig } from '../config/types';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';
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
  emitPromptActivity,
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
import {
  unattendedConversations,
  type UnattendedJobMeta,
} from '../sidebar/unattendedConversations';
import { formatChatMessage, formatChatMirrorLine } from '../sidebar/chatMessageText';
import {
  activeChatIds,
  chatRefs,
  closedChatHint,
  closedChatRefs,
  formatChatId,
  formatChatList,
  formatChatName,
  resolveChatReference,
  resolveViewTarget,
  type ChatRef,
  type ChatReferenceResolution,
} from './chatMessageResolver';
import { peerNew, peerSend, peerSteer, peerView } from './messageChatPeerActions';
import {
  discoverPeers,
  formatPeerSection,
  peerContextFor,
  peerWindowTarget,
  resolvePeerTarget,
  type PeerChatRef,
  type PeerContext,
  type PeerTarget,
} from './messageChatPeers';
import { peerWorkerTitle, pickWorkerModel } from './messageChatNewChat';

/** The sidebar seam the tool dispatches through, re-exported so the tests and
 *  the wiring name it from the tool that uses it. */
export type MessageChatSidebar = MessageChatActionSidebar;

/** A refusal that also shows the caller the chats it can address instead. */
function listRefusal(message: string, chats: ChatRef[], selfId: string): string {
  return `${message}\n\n${formatChatList(chats, selfId)}`;
}

function messageFrom(sender: ChatRef, chats: ChatRef[], text: string): string {
  const senderId = formatChatId(sender.id, chats);
  return formatChatMessage(sender.title, senderId, text);
}

export function makeMessageChatTool(options: {
  getSidebar: () => MessageChatSidebar | undefined;
  getConfig?: () => ForgeConfig;
  now?: () => number;
  /** This window's bus address, or undefined while the bus is off — which is
   *  also the shape a test uses to say "no other windows exist here". Defaults
   *  to the live bus folder and window id. */
  getPeerContext?: () => PeerContext | undefined;
  /** How the other windows are found. Overridable so a test can say "there is
   *  one peer, holding these chats" without a real bus folder and a socket. */
  discoverPeers?: typeof discoverPeers;
}): RegisteredTool {
  const windows = new Map<string, MessageChatWindow>();
  const now = options.now ?? Date.now;
  const actions = createMessageChatActions();
  // This window's bus address. Undefined while the bus is off, which keeps
  // every peer branch off and `list` printing exactly what it printed before
  // cross-window messaging existed.
  const peerContext = (): PeerContext | undefined =>
    options.getPeerContext ? options.getPeerContext() : peerContextFor(options.getConfig);
  const listPeers = options.discoverPeers ?? discoverPeers;
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
        const local = formatChatList(chats, selfId);
        const ctx = peerContext();
        if (!ctx) return local;
        // Re-read disk every call: a window that reloads comes back with a new
        // id and token, and a cached list would name the one that went away.
        const { peers, unreachable } = await listPeers(ctx, context?.abortSignal);
        return `${local}${formatPeerSection(peers, unreachable)}`;
      }

      const window = windowFor(selfId);
      const at = now();
      pruneMessageChatWindow(window, at);
      // `new_chats_per_hour` is the owner's dial on how many workers one chat may
      // open in a window; the config default is 100 (owner raised it 2026-11-08),
      // counted against the same 30-minute window as sends and wakes.
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
        ...((): { unattended?: { job?: UnattendedJobMeta } } => {
          if (!unattendedConversations.has(selfId)) return {};
          const job = unattendedConversations.jobMeta(selfId);
          return { unattended: job ? { job } : {} };
        })(),
        window,
        at,
        newChatsPerHour,
        ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
        formatName: formatChatName,
        refuse: (message: string) => listRefusal(message, chats, selfId),
        emitActivity: (id: string, text: string) => emitPromptActivity(hostFacade, id, text),
        formatMirrorLine: formatChatMirrorLine,
      };

      /** A chat id that is not open here may be open in a peer window. Only a
       *  full id is looked up: `#N` and title words mean something different in
       *  every window, and a wrong guess costs the owner a paid turn there. */
      const peerOf = (ref: string | undefined) =>
        resolvePeerTarget(ref, peerContext(), listPeers, context?.abortSignal);
      /** The refusal for a `to` matched nowhere, plus what the other windows have
       *  to say about it — that it lives next door, or that this window cannot
       *  ask and which switch would let it. */
      const unmatchedRefusal = async (
        resolution: Extract<ChatReferenceResolution, { ok: false }>,
        peer: PeerTarget,
      ): Promise<string> =>
        listRefusal(
          `Error: ${resolution.reason}${closedChatHint(resolution, parsed.to, closed, selfId)}${
            'note' in peer ? peer.note : ''
          }`,
          chats,
          selfId,
        );

      /** What a peer action needs on top of the local context: the chat, the
       *  message and this window's folder (the prompt names it, so the other chat
       *  knows where to answer). */
      const peerBase = (target: PeerChatRef, selfWorkspace: string, message: string) => ({
        ...baseContext,
        message,
        target,
        selfWorkspace,
      });

      if (parsed.action === 'view') {
        const target = resolveViewTarget(parsed.to, chats, closed, selfId);
        if (!target.ok) {
          // A full id this window does not hold may belong to a peer window: the
          // same read, answered there and rendered by the same function.
          const peer = await peerOf(parsed.to);
          if ('chat' in peer)
            return peerView({
              target: peer.chat,
              ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
            });
          return target.refusal;
        }
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
            `Error: message_chat could not read ${formatChatName(target.chat)}: ${String(error)}.`,
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
        const model = pickWorkerModel({
          ...(parsed.model !== undefined ? { requested: parsed.model } : {}),
          ...(sender.model ? { senderModel: sender.model } : {}),
          openedHere: parsed.window === undefined,
          ...(options.getConfig ? { config: options.getConfig() } : {}),
        });
        if ('refusal' in model) return listRefusal(model.refusal, chats, selfId);
        const pinModel = model.pinModel;
        // A `window` names another window, and that one owns its own sidebar,
        // chat cap and prologue lock — so this window only asks, and burns the
        // same counters a local `new` would.
        if (parsed.window !== undefined) {
          const where = await peerWindowTarget(
            parsed.window,
            peerContext(),
            listPeers,
            context?.abortSignal,
          );
          if (!('peer' in where)) return listRefusal(where.refusal, chats, selfId);
          return peerNew({
            ...baseContext,
            message: workerMessage,
            ...where,
            title: peerWorkerTitle(sender, workerMessage),
            ...(pinModel ? { pinModel } : {}),
          });
        }
        const actionContext: MessageChatActionContext = {
          ...baseContext,
          message: workerMessage,
          steerAvailable: flags.steer,
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
        if (!resolution.ok) {
          // A full chat id this window does not know may be a peer chat: the steer
          // goes over there, on that window's fresh report of the chat.
          const peer = await peerOf(parsed.to);
          if ('chat' in peer)
            return await peerSteer({
              ...peerBase(peer.chat, peer.selfWorkspace, steerMessage),
              steerAction: actions.steer,
            });
          return await unmatchedRefusal(resolution, peer);
        }
        const actionContext: MessageChatActionContext = {
          ...baseContext,
          message: steerMessage,
          formatMessage: () => messageFrom(sender, chats, steerMessage),
        };
        return actions.steer({
          ...actionContext,
          target: resolution.chat,
          activeIds: activeChatIds(status),
          deliver: (text, conversationId, running) =>
            sidebar.deliverChatMessage(text, conversationId, running),
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
      if (!resolution.ok) {
        // A full chat id this window does not know may belong to a peer window:
        // the whole send goes over there, so no local guard or counter runs it.
        const peer = await peerOf(parsed.to);
        if ('chat' in peer)
          return say(await peerSend(peerBase(peer.chat, peer.selfWorkspace, parsed.message)));
        return say(await unmatchedRefusal(resolution, peer));
      }
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
          baseContext.unattended
            ? sidebar.deliverChatMessage(
                messageFrom(sender, chats, parsed.message),
                target.id,
                false,
                baseContext.unattended,
              )
            : sidebar.deliverChatMessage(messageFrom(sender, chats, parsed.message), target.id),
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
        return say(
          `Queued for ${name} (running): not processed yet; it will be read at a tool round or in a follow-up turn.`,
        );
      if (delivery.kind === 'turn')
        return say(`Delivered to ${name} (idle): a turn started there.`);
      return say(
        `Sent to ${name}, but its turn had not started after ${delivery.why === 'timeout' ? `${MESSAGE_CHAT_DELIVERY_CONFIRM_MS / 1000} s` : 'this turn was stopped'}; it may still start. Do not resend; check with \`list\` later.`,
      );
    },
  };
}
