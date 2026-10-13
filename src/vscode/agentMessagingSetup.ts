import * as vscode from 'vscode';
import * as path from 'path';
import { busPaths, removeLegacyAliasFiles } from '../agentBus/agentBus';
import { EXCHANGES_LOG_NAME, readEvents } from '../agentMesh/exchangeLog';
import { setBoardContext } from '../agentMesh/meshContext';
import {
  AgentInbox,
  type ChatTargetSelection,
  type InboxMessageOptions,
} from '../agentBus/agentInbox';
import { AgentRoutes } from '../backend/agentRoutes';
import { availableProfilesFor, expandAlias } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import { BUS_TARGET_SCAN, senderConversation } from '../agentBus/busTarget';
import { busTarget, submitBusMessage } from './agentBusSubmission';
export { submitBusMessage } from './agentBusSubmission';
import { BusTurnWatch } from '../agentBus/busTurnWatch';
import { renderBusStatus, renderBusView } from '../agentBus/busStatusView';
import { MAX_VIEW_COUNT, parseViewCount } from '../remote/RemoteTranscriptView';
import type { RemoteRuntime } from '../remote/RemoteRuntime';
import { PendingAgentReplies } from '../agentLinks/pendingAgentReplies';
import { makeAskAgentRuntime } from '../agentLinks/askAgentRuntime';
import type { AskAgentRuntime } from '../agentLinks/askAgentService';
import { findBySession } from '../agentLinks/chatAgentLinks';
import {
  makeAgentReplyLifecycle,
  recordAcceptedInboundReply,
} from '../agentLinks/agentReplyLifecycle';
import { makeAgentToAgentRelay } from '../agentLinks/agentToAgentRelay';
import { isAskAgentRunning } from '../agentLinks/askAgentService';

/** The chat a bus exchange belongs to, from the exchange ledger. */
export function exchangeConversationFromLedger(exchangeId: string): string | undefined {
  const events = readEvents(path.join(busPaths().root, EXCHANGES_LOG_NAME));
  return events.find((event) => event.exchangeId === exchangeId && event.conversation)
    ?.conversation;
}

/** Resolve the chat a Forge-directed bus message will enter. */
export function resolveBusMessageTarget(
  facade: ForgeHostFacade,
  from: string,
  selection: ChatTargetSelection,
  exchangeConversation?: (id: string) => string | undefined,
):
  | { ok: true; conversationId: string; title: string }
  | { ok: false; status: 404 | 409; error: string } {
  const status = facade.status();
  let conversationId: string;
  if (selection.conversationId) {
    conversationId = selection.conversationId;
  } else if (selection.toRunning) {
    const streaming = status.streamingConversationIds;
    if (streaming.includes(status.activeConversationId)) {
      conversationId = status.activeConversationId;
    } else if (streaming.length === 1) {
      conversationId = streaming[0] as string;
    } else if (streaming.length === 0) {
      return { ok: false, status: 409, error: 'Forge has no running chat to target' };
    } else {
      return {
        ok: false,
        status: 409,
        error: 'Forge has multiple running chats; use --to <conversationId>',
      };
    }
    if (!streaming.includes(conversationId)) {
      return { ok: false, status: 409, error: 'the selected Forge chat is not running' };
    }
  } else {
    conversationId = busTarget(facade, from);
  }
  const conversation = status.conversations.find((item) => item.id === conversationId);
  if (!conversation || conversation.archived) {
    // A verdict file is named after the exchange, so its id is the one a peer
    // has to hand; "no longer open" sent one to a fresh chat instead.
    const owner =
      !conversation && selection.conversationId
        ? exchangeConversation?.(conversationId)
        : undefined;
    return {
      ok: false,
      status: 404,
      error: owner
        ? `"${conversationId}" is an exchange id, not a chat id: its chat is --to ${owner}`
        : `Forge chat "${conversationId}" is no longer open`,
    };
  }
  return { ok: true, conversationId, title: conversation.title };
}

type StreamingBusTarget =
  | { ok: true; conversationId: string; title: string }
  | { ok: false; status: 400 | 409; error: string };

/** Resolve a sender's target and require a running turn for stop or steer. */
function resolveStreamingBusTarget(
  facade: ForgeHostFacade,
  from: string,
  targetConversationId?: string,
): StreamingBusTarget {
  const target = resolveBusMessageTarget(
    facade,
    from,
    { ...(targetConversationId ? { conversationId: targetConversationId } : {}) },
    exchangeConversationFromLedger,
  );
  if (!target.ok) return { ok: false, status: 400, error: target.error };
  if (!facade.status().streamingConversationIds.includes(target.conversationId)) {
    return {
      ok: false,
      status: 409,
      error: `Forge chat "${target.title}" (${target.conversationId}) is not streaming`,
    };
  }
  return { ok: true, conversationId: target.conversationId, title: target.title };
}

/** Interrupt only the chat the sender's message will be routed to. */
export async function interruptForgeForSender(
  facade: ForgeHostFacade,
  from: string,
  targetConversationId?: string,
): Promise<
  { steered: true; conversationId: string; title: string } | { steered: false; reason: string }
> {
  const target = resolveStreamingBusTarget(facade, from, targetConversationId);
  if (!target.ok) return { steered: false, reason: target.error };
  await facade.interrupt(target.conversationId);
  return {
    steered: true,
    conversationId: target.conversationId,
    title: target.title,
  };
}

/** Cancel the addressed turn with the same target selection as bus messages and steers. */
export async function stopForgeForSender(
  facade: ForgeHostFacade,
  from: string,
  targetConversationId?: string,
): Promise<StreamingBusTarget> {
  const target = resolveStreamingBusTarget(facade, from, targetConversationId);
  if (!target.ok) return target;
  await facade.cancel(target.conversationId);
  return target;
}

/** Every model, each `model@profile` it offers, and every alias key: the ids a bus sender may name. */
export function busModelIds(config: ForgeConfig): string[] {
  return [
    ...config.models.flatMap((model) => [
      model.name,
      ...availableProfilesFor(config, model.name).map((profile) => `${model.name}@${profile}`),
    ]),
    ...Object.keys(config.aliases ?? {}),
  ];
}

/**
 * Mounts inbound messaging routes and the inbox, and connects session links
 * to `ask_agent` and host-side relays. The sidebar is lazy:
 * activation may start the control server before its provider exists, so the
 * inbox waits until `getSidebar` can resolve the target chat.
 */
export function setupAgentMessaging(
  context: vscode.ExtensionContext,
  getSidebar: () => { getHostFacade(): ForgeHostFacade; readonly tellDrain: MidTurnTellDrain },
  getConfig: () => ForgeConfig,
  workspaceRoot: string,
  getRemoteRuntime: () => RemoteRuntime | undefined = () => undefined,
): AgentRoutes {
  const paths = busPaths();
  removeLegacyAliasFiles(paths, (message) => {
    void vscode.window.showWarningMessage(message);
  });
  setBoardContext({
    root: paths.root,
    workspace: workspaceRoot,
    log: path.join(paths.root, EXCHANGES_LOG_NAME),
  });
  const pendingReplies = new PendingAgentReplies(busPaths().root);
  const askRuntime: AskAgentRuntime = makeAskAgentRuntime({ getConfig });
  const replyLifecycle = makeAgentReplyLifecycle({
    root: busPaths().root,
    workspaceRoot,
    pending: pendingReplies,
    runtime: askRuntime,
    getFacade: () => getSidebar().getHostFacade(),
    showWarning: (message) => {
      void vscode.window.showWarningMessage(message);
    },
  });
  const linkedAgentOwner = (
    sender: import('../agentLinks/chatAgentLinks').AgentSender,
  ): string | undefined => {
    const owner = findBySession(sender.sessionId);
    return owner &&
      getSidebar().getHostFacade().getAgentLink(owner, sender.kind)?.sessionId === sender.sessionId
      ? owner
      : undefined;
  };
  const watch = new BusTurnWatch();
  const inbox = new AgentInbox({
    isBusy: (options?: InboxMessageOptions) => {
      if (options?.newChat) return false;
      const facade = getSidebar().getHostFacade();
      registerTellSource(); // every queued message asks this first
      return facade
        .status()
        .streamingConversationIds.includes(
          busTarget(facade, options?.from, options?.targetConversationId),
        );
    },
    submit: async (prompt, options?: InboxMessageOptions) => {
      const facade = getSidebar().getHostFacade();
      watch.attach(facade);
      await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
      // An alias is resolved here so the chat stores the model id its picker shows.
      const model = options?.model && expandAlias(getConfig(), options.model);
      return submitBusMessage(facade, prompt, model ? { ...options, model } : options);
    },
    warn: (message) => void vscode.window.showWarningMessage(message),
    // F-08: a bus-started turn began — write its durable status file so a
    // crashed turn can be detected at the next window's startup.
    // F-08: a bus-started turn ended (success OR failure) — clear its status
    // file. The inbox calls this in a `finally`, so a normal finish never
    // leaves a stale "running" record; only a crash does, and the startup
    // sweep detects that.
    // §9 (P1): a bus-started turn just ended — successfully, or as a failure the
    // inbox is telling about. The sender gets one `finished`/`failed` line via
    // tell (which writes the board event), so there are no silent stalls. A
    // user-typed turn has no bus sender, so this never fires for it.
    ...replyLifecycle,
  });
  context.subscriptions.push(inbox);
  context.subscriptions.push(watch);
  // A chat that is mid-turn reads its waiting bus messages at the next
  // tool-round gap, the way Telegram and typed messages reach it. The sidebar
  // may not exist yet at activation, so the first busy check registers it.
  let tellSourceRegistered = false;
  const registerTellSource = (): void => {
    if (tellSourceRegistered) return;
    getSidebar().tellDrain.registerSource('agent-bus', (conversationId) => {
      const facade = getSidebar().getHostFacade();
      const prompts = inbox.claimMidTurn(conversationId, (options) =>
        busTarget(facade, options?.from, options?.targetConversationId),
      );
      return Promise.resolve({
        messages: prompts.map((content) => ({ role: 'user' as const, content, midTurn: true })),
      });
    });
    tellSourceRegistered = true;
  };
  const readTarget = (from: string) => {
    const facade = getSidebar().getHostFacade();
    watch.attach(facade);
    const status = facade.status();
    const id = senderConversation(from, status, (cid) =>
      facade.recentExchanges(cid, BUS_TARGET_SCAN),
    );
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
  const routes = new AgentRoutes({
    paths: () => busPaths(),
    inbox,
    pendingReplies,
    workspaceRoot,
    recordPendingAccepted: (record) => recordAcceptedInboundReply(busPaths().root, record),
    isChatBusy: (conversationId) =>
      getSidebar().getHostFacade().status().streamingConversationIds.includes(conversationId),
    holdsLink: (sender) => {
      return linkedAgentOwner(sender) !== undefined;
    },
    resolveInboundAgent: (sender, selection) =>
      getSidebar().getHostFacade().routeInboundAgent(sender, selection),
    showMovedNotice: (conversationId, message) =>
      getSidebar().getHostFacade().showConversationNotice(conversationId, message),
    isFocused: () => vscode.window.state.focused,
    configuredModels: () => busModelIds(getConfig()),
    relayAgent: makeAgentToAgentRelay(
      () => getSidebar().getHostFacade(),
      busPaths().root,
      workspaceRoot,
      askRuntime,
    ),
    validateAgentSender: (sender) =>
      linkedAgentOwner(sender)
        ? { ok: true }
        : { ok: false, error: 'sender session is not linked to an open Forge chat' },
    // F-06: a `priority=steer` message interrupts the recipient's active turn.
    // §6: a steer to Forge itself interrupts Forge's running turn. It is the
    // last steer left since Telegram `/steer` was removed (MID_TURN_TELL
    // Phase 4). An idle chat has nothing to interrupt.
    resolveChatTarget: (from, selection) =>
      resolveBusMessageTarget(
        getSidebar().getHostFacade(),
        from,
        selection,
        exchangeConversationFromLedger,
      ),
    interruptForge: async (from, conversationId) => {
      const facade = getSidebar().getHostFacade();
      return interruptForgeForSender(facade, from, conversationId);
    },
    stopForge: async (from, conversationId) => {
      const facade = getSidebar().getHostFacade();
      return stopForgeForSender(facade, from, conversationId);
    },
    // A `--new` message needs a tab to exist. Ask the sidebar NOW whether one
    // could be opened, so the route can answer 409 with the reasons instead of
    // answering 202 and dropping the message in `drain()`.
    chatCapBlockers: (options) => getSidebar().getHostFacade().chatCapBlockers(options),
    who: () => {
      const facade = getSidebar().getHostFacade();
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
    status: (from) => {
      const target = readTarget(from);
      if (!target.ok) return target;
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
    view: (from, count) => {
      const target = readTarget(from);
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
    // §8/P3: a `to: forge` message that parses as a typed lifecycle command is
    // dispatched (standby/wake/close/steer/say/handoff) and the reply returned
    // to the caller's `forge.sh cmd` call. Ordinary text falls through to the inbox.
  });
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) routes.claim();
    }),
  );
  void replyLifecycle.recover().catch((error: unknown) => {
    void vscode.window.showWarningMessage(
      `Forge could not recover pending agent replies: ${String(error)}`,
    );
  });
  return routes;
}
