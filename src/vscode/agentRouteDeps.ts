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

import { busPaths } from '../agentBus/agentBus';
import type { AgentInbox } from '../agentBus/agentInbox';
import { BUS_TARGET_SCAN, senderConversation } from '../agentBus/busTarget';
import { renderBusStatus, renderBusView, renderQueuedStatus } from '../agentBus/busStatusView';
import type { BusTurnWatch } from '../agentBus/busTurnWatch';
import type { ForgeConfig } from '../config/types';
import { makeAgentToAgentRelay, makeAgentToAgentSteer } from '../agentLinks/agentToAgentRelay';
import { recordAcceptedInboundReply } from '../agentLinks/agentReplyLifecycle';
import { isAskAgentRunning, type AskAgentRuntime } from '../agentLinks/askAgentService';
import { agentKindSchema, type AgentSender } from '../agentLinks/chatAgentLinks';
import { findSessionChatIn } from '../agentLinks/chatAgentLinks';
import { PendingAgentReplies } from '../agentLinks/pendingAgentReplies';
import type { AgentRoutesDeps } from '../backend/agentRoutes';
import { validateBusSenderName } from '../backend/agentSenderParsing';
import type { RemoteRuntime } from '../remote/RemoteRuntime';
import { MAX_VIEW_COUNT, parseViewCount } from '../remote/RemoteTranscriptView';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import {
  busModelIds,
  exchangeConversationFromLedger,
  interruptForgeForSender,
  resolveBusMessageTarget,
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
  inbox: Pick<AgentInbox, 'accept' | 'cancel' | 'pendingFrom' | 'queuedTargetConversation'>;
  watch: BusTurnWatch;
  pendingReplies: PendingAgentReplies;
  askRuntime: AskAgentRuntime;
  getRemoteRuntime(): RemoteRuntime | undefined;
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
    isFocused,
  } = hosts;
  const busAt = () => busPaths(home);
  const readTarget = (from: string, sender?: AgentSender) => {
    const facade = getFacade();
    watch.attach(facade);
    const status = facade.status();
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
      resolveBusMessageTarget(getFacade(), from, selection, exchangeConversationFromLedger),
    interruptForge: async (from, conversationId) =>
      interruptForgeForSender(getFacade(), from, conversationId),
    stopForge: async (from, conversationId) =>
      stopForgeForSender(getFacade(), from, conversationId),
    // A `--new` message needs a tab to exist. Ask the sidebar NOW whether one
    // could be opened, so the route can answer 409 with the reasons instead of
    // answering 202 and dropping the message in `drain()`.
    chatCapBlockers: (options) => getFacade().chatCapBlockers(options),
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
    status: (from, sender) => {
      const target = readTarget(from, sender);
      if (!target.ok) {
        // F3: the message is accepted and queued and has no open chat to show
        // yet (`--new` opens its own when it runs), so answer 200 with the
        // queue instead of the 404 that made `forge.sh wait` exit 1 on a queue
        // it had just been told existed.
        const queued = inbox.pendingFrom(from);
        if (queued > 0) return { ok: true, text: renderQueuedStatus(queued) };
        return target;
      }
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
        }),
      };
    },
    view: (from, count, sender) => {
      const target = readTarget(from, sender);
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
    sendFile: async (from, conversationId, filePath, caption) => {
      const target = readTarget(from);
      if (!target.ok) return { kind: 'refused', error: target.error };
      if (target.id !== conversationId) {
        return {
          kind: 'refused',
          error: `The selected conversation does not match ${from}'s established Forge chat.`,
        };
      }
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
  };
}
