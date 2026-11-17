/**
 * The production agent-route dependency set: which routes a Forge window
 * registers, and what each one does.
 *
 * Built here rather than inside `setupAgentMessaging` so a contract test can
 * build the *same* object with fakes and prove every verb `forge.sh` advertises
 * has a registered route. The 0.17.86 audit (F1) is what this file exists to
 * make impossible to repeat: `/agent/read-verdict` and `/agent/ack-verdict` were
 * registered only when an optional dependency (`validateFrom`) was present, and
 * nothing in production ever supplied it, so both answered `no route` while the
 * client, the bus README and `AI_SETUP.md` advertised them. A handler with no
 * caller is the wired half of a bug pointing at itself (CLAUDE.md, Single Point
 * of Truth); a route that is never registered is the same bug one level up.
 */

import * as path from 'path';
import { busPaths } from '../agentBus/agentBus';
import type { AgentInbox } from '../agentBus/agentInbox';
import { BUS_TARGET_SCAN, senderConversation } from '../agentBus/busTarget';
import { renderBusStatus, renderBusView, renderQueuedStatus } from '../agentBus/busStatusView';
import type { BusTurnWatch } from '../agentBus/busTurnWatch';
import type { ForgeConfig } from '../config/types';
import { makeAgentToAgentRelay, makeAgentToAgentSteer } from '../agentLinks/agentToAgentRelay';
import { chatNotOpenHereMessage } from '../agentLinks/inboundAgentRouting';
import { recordAcceptedInboundReply } from '../agentLinks/agentReplyLifecycle';
import { isAskAgentRunning, type AskAgentRuntime } from '../agentLinks/askAgentService';
import { agentKindSchema, type AgentSender } from '../agentLinks/chatAgentLinks';
import { findSessionChatIn } from '../agentLinks/chatAgentLinks';
import { PendingAgentReplies } from '../agentLinks/pendingAgentReplies';
import type { AgentRoutesDeps } from '../backend/agentRoutesDeps';
import { makeNotifyOwner } from '../backend/agentNotifyRoute';
import { defaultOutboxDir } from '../jobs/JobOutbox';
import type { ChatsReport } from '../backend/agentChatReadRoute';
import { chatRefs, closedChatRefs } from '../tools/chatMessageResolver';
import { validateBusSenderName } from '../backend/agentSenderParsing';
import type { RemoteRuntime } from '../remote/RemoteRuntime';
import { executeWindowReloadCommand } from './windowReload';
import { MAX_VIEW_COUNT, parseViewCount } from '../remote/RemoteTranscriptView';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import {
  busModelIds,
  exchangeConversationFromLedger,
  interruptForgeForSender,
  openBusChat,
  armBusChat,
  resolveBusMessageTarget,
  steerBlockReason,
  stopForgeForSender,
} from './agentBusSubmission';

/** Everything the production route set needs from the window, as one host
 *  object, so the test can hand the same shape with fakes in it. */
export interface AgentRouteDepsHosts {
  /** Resolved per call: the sidebar is lazy, and activation may start the
   *  control server before its provider exists. */
  getFacade(): ForgeHostFacade;
  getConfig(): ForgeConfig;
  workspaceRoot: string;
  /** The profile the bus folder lives under. Production leaves this unset (the
   *  real home); a test names a temporary one so the routes it exercises write
   *  their verdicts and pending replies there instead of into the operator's
   *  `~/.forge`. */
  home?: string;
  inbox: Pick<
    AgentInbox,
    'accept' | 'cancel' | 'release' | 'pendingFrom' | 'queuedTargetConversation'
  >;
  watch: BusTurnWatch;
  pendingReplies: PendingAgentReplies;
  askRuntime: AskAgentRuntime;
  getRemoteRuntime(): RemoteRuntime | undefined;
  rememberClaudeReopen?: (sessionId: string) => Promise<void>;
  reloadWindow?(): Promise<void>;
  isFocused(): boolean;
}

/** The window's own link holder for a session id, proven against the facade —
 *  the session index is process-wide and a session may now hold several chats,
 *  so the current one can belong to another window: newest first, but only a
 *  chat this window really holds, which is what `findSessionChatIn` does. */
function linkedAgentOwner(
  getFacade: () => ForgeHostFacade,
  sender: AgentSender,
): string | undefined {
  return findSessionChatIn(sender.sessionId, sender.kind, (id, kind) =>
    getFacade().getAgentLink(id, kind),
  );
}

/** The production dependency set. Every route `forge.sh` advertises must be
 *  reachable through what this returns; `test/unit/AgentRoutesVerbContract.test.ts`
 *  is the gate that says so. */
export function buildAgentRouteDeps(hosts: AgentRouteDepsHosts): AgentRoutesDeps {
  const {
    getFacade,
    getConfig,
    workspaceRoot,
    home,
    inbox,
    watch,
    pendingReplies,
    askRuntime,
    getRemoteRuntime,
    rememberClaudeReopen,
    isFocused,
  } = hosts;
  const busAt = () => busPaths(home);
  const readTarget = (from: string, sender?: AgentSender, conversationId?: string) => {
    const facade = getFacade();
    watch.attach(facade);
    const status = facade.status();
    if (conversationId !== undefined) {
      // `--to <id>` names a chat outright instead of asking which chat this
      // session last addressed. Two things have to hold: the chat is open in
      // this window, and this window's links tie it to the caller's own
      // session. A caller that gives an id but no session identity has nothing
      // to check the id against, so it is refused — reading another session's
      // chat by guessing its id is exactly what a read route must not allow.
      const conversation = status.conversations.find((item) => item.id === conversationId);
      if (!conversation || conversation.archived) {
        const owner = exchangeConversationFromLedger(conversationId, busAt().root);
        return {
          ok: false as const,
          status: 404 as const,
          error: owner
            ? `"${conversationId}" is an exchange id, not a chat id: its chat is --to ${owner}`
            : chatNotOpenHereMessage(conversationId),
        };
      }
      const link = sender ? facade.getAgentLink(conversationId, sender.kind) : undefined;
      if (!sender || link?.sessionId !== sender.sessionId) {
        return {
          ok: false as const,
          status: 404 as const,
          error: `Forge chat "${conversationId}" is not linked to ${from}'s session`,
        };
      }
      return { ok: true as const, facade, status, id: conversationId, conversation };
    }
    const kind = agentKindSchema.safeParse(from.trim().toLowerCase());
    const linkedId = sender ? linkedAgentOwner(getFacade, sender) : undefined;
    const id =
      linkedId ??
      senderConversation(
        from,
        status,
        (cid) => facade.recentExchanges(cid, BUS_TARGET_SCAN),
        kind.success
          ? (cid) => {
              const link = facade.getAgentLink(cid, kind.data);
              return link !== undefined && (!sender || link.sessionId === sender.sessionId);
            }
          : undefined,
      ) ??
      // F3: an accepted message is not an exchange yet, so until it starts the
      // inbox itself is the only record of the chat its sender's message was
      // routed into. Without this a sender's first message — the one that
      // earned the 202 it is waiting on — had no chat to read.
      inbox.queuedTargetConversation(from);
    if (id === undefined) {
      return {
        ok: false as const,
        status: 404 as const,
        error: `no chat holds a message from "${from}": send one with forge.sh say first`,
      };
    }
    const conversation = status.conversations.find((item) => item.id === id);
    if (conversation === undefined) {
      return {
        ok: false as const,
        status: 404 as const,
        error: `the chat for "${from}" is no longer open`,
      };
    }
    return { ok: true as const, facade, status, id, conversation };
  };
  return {
    paths: busAt,
    inbox,
    pendingReplies,
    workspaceRoot,
    recordPendingAccepted: (record) => recordAcceptedInboundReply(busAt().root, record),
    isChatBusy: (conversationId) =>
      getFacade().status().streamingConversationIds.includes(conversationId),
    holdsLink: (sender) => linkedAgentOwner(getFacade, sender) !== undefined,
    holdsChat: (conversationId) =>
      getFacade()
        .status()
        .conversations.some(
          (conversation) => conversation.id === conversationId && !conversation.archived,
        ),
    resolveInboundAgent: (sender, selection) => getFacade().routeInboundAgent(sender, selection),
    showAlsoLinkedNotice: (conversationId, message) =>
      getFacade().showConversationNotice(conversationId, message),
    isFocused,
    configuredModels: () => busModelIds(getConfig()),
    // A sender that is not an agent session is validated by the rule the bus
    // already applies to it: the name shape. Nothing more was ever asked of a
    // plain `from` — `say` accepts exactly these names — and each verdict route
    // authorizes the reader against the sender its exchange recorded, so a
    // well-formed but unrelated name still gets 404, never someone else's
    // verdict. Supplying it here is what registers those two routes.
    validateFrom: validateBusSenderName,
    relayAgent: makeAgentToAgentRelay(getFacade, busAt().root, workspaceRoot, askRuntime),
    // F2: `forge.sh steer <name> <agent>` had no handler in any window, so every
    // agent steer answered `no relay available to deliver to "<agent>"` while
    // steering Forge worked. The steer withdraws this chat's in-flight request
    // to that agent and runs its own text as the next relay.
    steer: makeAgentToAgentSteer(getFacade, busAt().root, workspaceRoot, askRuntime),
    validateAgentSender: (sender) =>
      linkedAgentOwner(getFacade, sender)
        ? { ok: true }
        : { ok: false, error: 'sender session is not linked to an open Forge chat' },
    // F-06: a `priority=steer` message interrupts the recipient's active turn.
    // §6: a steer to Forge itself interrupts Forge's running turn. It is the
    // last steer left since Telegram `/steer` was removed (MID_TURN_TELL
    // Phase 4). An idle chat has nothing to interrupt.
    resolveChatTarget: (from, selection) =>
      resolveBusMessageTarget(getFacade(), from, selection, (id) =>
        exchangeConversationFromLedger(id, busAt().root),
      ),
    recordPeerWriter: (conversationId, writer) => {
      const conversation = getFacade().getConversation(conversationId);
      if (conversation) conversation.latestPeerWriter = writer;
    },
    interruptForge: async (from, conversationId, expectedEpoch) =>
      interruptForgeForSender(getFacade(), from, conversationId, expectedEpoch),
    // A steer is refused before its message is queued, because a queued message
    // cannot always be withdrawn: the drain may start it in the same tick the
    // route answers in. The chat is named here, so the card and the chain are
    // read for that chat alone.
    steerGuard: (conversationId, title, expectedEpoch) =>
      conversationId === undefined
        ? undefined
        : steerBlockReason(getFacade(), conversationId, title ?? conversationId, expectedEpoch),
    stopForge: async (from, conversationId) =>
      stopForgeForSender(getFacade(), from, conversationId),
    prepareReload: (from, conversationId, force) => {
      const facade = getFacade();
      const target = resolveBusMessageTarget(facade, from, { conversationId }, (id) =>
        exchangeConversationFromLedger(id, busAt().root),
      );
      if (!target.ok) return target;
      const status = facade.status();
      const running = new Set(status.streamingConversationIds);
      const runningTitles = status.conversations
        .filter((conversation) => running.has(conversation.id))
        .map((conversation) => conversation.title);
      if (runningTitles.length > 0 && !force) {
        return {
          ok: false as const,
          status: 409,
          error:
            `forge.sh: that window has running turns: ${runningTitles.join(', ')}. ` +
            'Run reload again with --force to reload anyway.',
        };
      }
      return {
        ok: true as const,
        workspaceFolderName: path.win32.basename(workspaceRoot.replace(/[\\/]+$/u, '')),
      };
    },
    reloadWindow: hosts.reloadWindow ?? executeWindowReloadCommand,
    ...(rememberClaudeReopen ? { rememberClaudeReopen } : {}),
    // A `--new` message needs a tab to exist. Ask the sidebar NOW whether one
    // could be opened, so the route can answer 409 with the reasons instead of
    // answering 202 and dropping the message in `drain()`.
    chatCapBlockers: (options) => getFacade().chatCapBlockers(options),
    // A `--new` opens its chat here, so the 202 can name it and a pin failure
    // can be answered 409 with that id. Same `openBusChat` the drain calls, so
    // a bus `--new` and a `message_chat new` cannot race each other's pin.
    openBusChat: (options) => openBusChat(getFacade(), options),
    // A sender's `--new` opens its chat through the agent-link path, not through
    // `openBusChat` above, so it arms Clanker here.
    armBusChat: (conversationId, sender) => armBusChat(getFacade(), conversationId, sender),
    who: () => {
      const facade = getFacade();
      const status = facade.status();
      return status.conversations.flatMap((conversation) =>
        (['claude', 'codex', 'copilot'] as const).flatMap((kind) => {
          const linked = facade.getAgentLink(conversation.id, kind);
          return linked
            ? [
                {
                  session: `${kind} · ${linked.title}`,
                  attachment: 'linked',
                  activity: isAskAgentRunning(conversation.id) ? 'busy' : 'idle',
                  detail: conversation.title,
                },
              ]
            : [];
        }),
      );
    },
    status: (from, sender, conversationId) => {
      const target = readTarget(from, sender, conversationId);
      if (!target.ok) {
        // F3: the message is accepted and queued and has no open chat to show
        // yet (`--new` opens its own when it runs), so answer 200 with the
        // queue instead of the 404 that made `forge.sh wait` exit 1 on a queue
        // it had just been told existed. Only for a sender with no chat named:
        // the queue says nothing about the specific chat an explicit `--to`
        // asked for, so that request keeps its 404.
        if (conversationId === undefined) {
          const queued = inbox.pendingFrom(from);
          if (queued > 0) return { ok: true, text: renderQueuedStatus(queued) };
        }
        return target;
      }
      const approval = target.facade.pendingApprovalForConversation(target.id);
      const waiting = approval
        ? {
            kind: 'approval' as const,
            toolName: approval.toolName,
            ownerOnly: approval.waitingForOwner === true,
          }
        : target.facade.hasPendingQuestion(target.id)
          ? { kind: 'question' as const }
          : undefined;
      return {
        ok: true,
        text: renderBusStatus({
          conversation: target.conversation,
          streaming: target.status.streamingConversationIds.includes(target.id),
          queuedFromSender: inbox.pendingFrom(from),
          budget: target.facade.contextBudget(target.id),
          turn: watch.snapshot(target.id),
          watchAttached: watch.attached,
          now: Date.now(),
          ...(waiting ? { waiting } : {}),
        }),
      };
    },
    view: (from, count, sender, conversationId) => {
      const target = readTarget(from, sender, conversationId);
      if (!target.ok) return target;
      const requested = parseViewCount(count);
      if (requested.kind === 'invalid') {
        return { ok: false, status: 400, error: `count must be 1-${MAX_VIEW_COUNT}` };
      }
      return {
        ok: true,
        text: renderBusView(target.facade.recentExchanges(target.id, requested.count), {
          clamped: requested.clamped,
          streaming: target.status.streamingConversationIds.includes(target.id),
        }),
      };
    },
    // `GET /agent/chats`: which chats this window holds, for a chat in another
    // window that has to address one by id. Built from the same two functions
    // the `message_chat` tool builds its own list from, so "which chats are
    // open, and which of them are running" has one answer in this window rather
    // than two that can drift. No `#N` — a peer that guessed a tab number would
    // steer whoever happened to hold it.
    chats: (windowId) => {
      const status = getFacade().status();
      // A card this window cannot tie to a chat blocks every chat it reports:
      // the guard exists to stop a steer interrupting a question the owner has
      // not answered, and reading "no card anywhere" from a missing id is the
      // wrong way to be wrong.
      const approval = status.pendingApproval;
      const blocksApproval = (id: string) =>
        approval !== undefined &&
        (approval.conversationId === undefined || approval.conversationId === id);
      const epochs = new Map(
        status.requestChains.map((chain) => [chain.conversationId, chain.userIntentEpoch]),
      );
      const report = (refs: ReturnType<typeof chatRefs>, closed: boolean): ChatsReport['chats'] =>
        refs.map((chat) => {
          const epoch = epochs.get(chat.id);
          return {
            id: chat.id,
            title: chat.title,
            running: chat.running,
            closed,
            awaitingApproval: !closed && blocksApproval(chat.id),
            ...(epoch === undefined ? {} : { userIntentEpoch: epoch }),
            ...(chat.model ? { model: chat.model } : {}),
          };
        });
      return {
        windowId,
        workspace: workspaceRoot,
        models: [...busModelIds(getConfig())],
        chats: [...report(chatRefs(status), false), ...report(closedChatRefs(status), true)],
      };
    },
    // `GET /agent/peer-view`: one chat's transcript for a window that has
    // nothing but the token and the chat's id. Read-only by construction —
    // `status()` and the transcript, with no `watch.attach`, no restore and no
    // model load, so a neighbour reading a chat cannot move the owner's tab or
    // wake an engine behind their back.
    peerView: (conversationId, count, windowId) => {
      const facade = getFacade();
      const status = facade.status();
      const open = chatRefs(status).find((chat) => chat.id === conversationId);
      const closed = open
        ? undefined
        : closedChatRefs(status).find((chat) => chat.id === conversationId);
      const chat = open ?? closed;
      if (!chat)
        return {
          ok: false as const,
          status: 404 as const,
          error: chatNotOpenHereMessage(conversationId),
        };
      // One more than the caller asked for, so "there was more" is a measurement
      // taken here rather than a guess made at the far end.
      const fetched = facade.recentExchanges(conversationId, count + 1);
      return {
        ok: true as const,
        report: {
          windowId,
          workspace: workspaceRoot,
          conversationId,
          title: chat.title,
          closed: closed !== undefined,
          streaming: status.streamingConversationIds.includes(conversationId),
          clamped: fetched.length > count,
          exchanges: fetched.slice(Math.max(fetched.length - count, 0)),
        },
      };
    },
    sendFile: async (from, sender, conversationId, filePath, caption) => {
      // The chat is named, so it is checked against the sender's own session
      // link — not against "the chat this sender last wrote to", which is a
      // different chat the moment the session holds two of them.
      const target = readTarget(from, sender, conversationId);
      if (!target.ok) return { kind: 'refused', error: target.error };
      const runtime = getRemoteRuntime();
      if (!runtime) {
        return {
          kind: 'refused',
          error: 'The active remote runtime is not available in this VS Code window.',
        };
      }
      return runtime.sendFileToConversation(conversationId, filePath, caption);
    },
    remoteSession: async (from, sessionId, id, action, text) => {
      const runtime = getRemoteRuntime();
      return runtime
        ? runtime.remoteSessionAction(from, sessionId, id, action, text)
        : { kind: 'refused', error: 'the remote runtime is unavailable' };
    },
    notifyOwner: makeNotifyOwner(getConfig, defaultOutboxDir(home)),
  };
}
