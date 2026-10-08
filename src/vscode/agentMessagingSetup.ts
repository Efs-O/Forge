import * as vscode from 'vscode';
import * as path from 'path';
import { busPaths } from '../agentBus/agentBus';
import { EXCHANGES_LOG_NAME, readEvents } from '../agentMesh/exchangeLog';
import {
  AgentInbox,
  busTurnEndLine,
  type ChatTargetSelection,
  type BusTurnEnd,
  type InboxMessageOptions,
} from '../agentBus/agentInbox';
import { AgentRoutes } from '../backend/agentRoutes';
import { joinClaude } from '../agentMesh/claudeJoin';
import { joinCodex } from '../agentMesh/codexJoin';
import { availableProfilesFor, expandAlias } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import { parseMeshCommand } from '../agentMesh/meshCommands';
import { projectWho } from '../agentMesh/meshWho';
import { readClaudeSessions } from '../agentBus/claudePeer';
import { parseForgeInboundPrompt } from '../agentBus/busContent';
import { setupAgentMesh } from './agentMeshSetup';
import { BUS_TARGET_SCAN, busTargetConversation, senderConversation } from '../agentBus/busTarget';
import { BusTurnWatch } from '../agentBus/busTurnWatch';
import { awaitedAnswers } from '../agentBus/awaitedAnswers';
import { renderBusStatus, renderBusView } from '../agentBus/busStatusView';
import { MAX_VIEW_COUNT, parseViewCount } from '../remote/RemoteTranscriptView';
import type { RemoteRuntime } from '../remote/RemoteRuntime';
import { unattendedConversations } from '../sidebar/unattendedConversations';
import { PendingAgentReplies } from '../agentLinks/pendingAgentReplies';
import { makeAskAgentRuntime } from '../agentLinks/askAgentRuntime';
import type { AskAgentRuntime } from '../agentLinks/askAgentService';
import { findBySession } from '../agentLinks/chatAgentLinks';
import {
  makeAgentReplyLifecycle,
  recordAcceptedInboundReply,
} from '../agentLinks/agentReplyLifecycle';
import { agentDisplayName } from '../agentLinks/chatAgentLinks';
import { makeAgentToAgentRelay } from '../agentLinks/agentToAgentRelay';

/** The conversation a bus message from `from` belongs in. */
function busTarget(
  facade: ForgeHostFacade,
  from: string | undefined,
  targetConversationId?: string,
): string {
  if (targetConversationId) return targetConversationId;
  return busTargetConversation(from, facade.status(), (id) =>
    facade.recentExchanges(id, BUS_TARGET_SCAN),
  );
}

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

/** Interrupt only the chat the sender's message will be routed to. */
export async function interruptForgeForSender(
  facade: ForgeHostFacade,
  from: string,
  targetConversationId?: string,
): Promise<
  { steered: true; conversationId: string; title: string } | { steered: false; reason: string }
> {
  const target = resolveBusMessageTarget(
    facade,
    from,
    { ...(targetConversationId ? { conversationId: targetConversationId } : {}) },
    exchangeConversationFromLedger,
  );
  if (!target.ok) return { steered: false, reason: target.error };
  if (!facade.status().streamingConversationIds.includes(target.conversationId)) {
    return {
      steered: false,
      reason: `Forge chat "${target.title}" (${target.conversationId}) is not streaming`,
    };
  }
  await facade.interrupt(target.conversationId);
  return {
    steered: true,
    conversationId: target.conversationId,
    title: target.title,
  };
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

/** The loaded chat model; config.active_model can be stale while the sidebar is open. */
function currentLoadedModel(facade: ForgeHostFacade): string | undefined {
  const status = facade.status();
  const active = status.conversations.find(
    (conversation) => conversation.id === status.activeConversationId,
  );
  return active?.activeModel ?? undefined;
}

/** An explicit new chat becomes visible; follow-ups keep their addressed chat. */

export async function submitBusMessage(
  facade: ForgeHostFacade,
  prompt: string,
  options: InboxMessageOptions | undefined,
): Promise<BusTurnEnd> {
  let conversationId = busTarget(facade, options?.from, options?.targetConversationId);
  // Read before createConversation: it activates the new chat, whose model is
  // the stale config default this is meant to replace.
  const current = options?.newChat && !options.model ? currentLoadedModel(facade) : undefined;
  if (options?.newChat) {
    conversationId = (await facade.createConversation({ activate: true })).id;
  } else if (conversationId !== facade.status().activeConversationId) {
    await facade.restoreConversation(conversationId, { activate: false });
  }
  if (options?.model) {
    await facade.setConversationModel(conversationId, options.model);
  } else if (current) {
    // A --new without --model follows the model the user is actually talking
    // to (the active conversation's model — the currently loaded backend), not
    // the stale config active_model that createConversation defaults to. That
    // stale default opened a new chat on a different model and loading it
    // spawned a second server.
    await facade.setConversationModel(conversationId, current);
  }
  const inbound = parseForgeInboundPrompt(prompt);
  if (inbound || options?.sender) {
    // The agent-bus sender cannot see the user's Telegram chat. Reuse the
    // normal host-activity subscription so the already-addressed conversation
    // is durably mirrored to its bound remote chats before the Forge turn runs.
    facade.emitHostActivity?.({
      conversationId,
      ...(options?.sender ? { suppressProgress: true } : {}),
      text: options?.sender
        ? `${agentDisplayName(options.sender.kind)} (${options.sender.title}) says: ${(inbound?.text ?? prompt).split(/\n\nFrom (?:Claude|Codex|Copilot) session /u)[0]!.trim()}`
        : `Forge: ${inbound?.from} says:\n\n${inbound?.text}`,
    });
  }
  // The marker lasts exactly this turn, like a job's: the conversation is
  // attended again for whoever writes in it next.
  const marker = options?.unattended ? unattendedConversations.mark(conversationId) : undefined;
  let outcome: Awaited<ReturnType<ForgeHostFacade['send']>>;
  try {
    outcome = options?.sender
      ? await facade.send(conversationId, prompt, undefined, { sender: options.sender })
      : await facade.send(conversationId, prompt);
  } finally {
    marker?.dispose();
  }
  return outcome.kind === 'failed'
    ? {
        kind: 'failed',
        error: outcome.error,
        ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
      }
    : { kind: outcome.kind, ...(outcome.finalText ? { finalText: outcome.finalText } : {}) };
}

/**
 * Mounts inbound messaging routes and the inbox, and initializes the mesh
 * orchestrator used by `ask_agent` and host-side relays. The sidebar is lazy:
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
  const mesh = setupAgentMesh(context, getSidebar, getConfig, workspaceRoot);
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
    onBusTurnStarted: (turnId) => {
      mesh.markTurnStarted(turnId);
    },
    // F-08: a bus-started turn ended (success OR failure) — clear its status
    // file. The inbox calls this in a `finally`, so a normal finish never
    // leaves a stale "running" record; only a crash does, and the startup
    // sweep detects that.
    onBusTurnStatusCleared: (turnId) => {
      mesh.markTurnFinished(turnId);
    },
    // §9 (P1): a bus-started turn just ended — successfully, or as a failure the
    // inbox is telling about. The sender gets one `finished`/`failed` line via
    // tell (which writes the board event), so there are no silent stalls. A
    // user-typed turn has no bus sender, so this never fires for it.
    onBusTurnFinished: (from, durationMs, end) => {
      void mesh.orchestrator
        .tell(from, busTurnEndLine(end, durationMs), { expectsReply: false })
        .catch((err) =>
          vscode.window.showWarningMessage(`[agent mesh] finished notice failed: ${String(err)}`),
        );
    },
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
      const owner = findBySession(sender.sessionId);
      return (
        owner !== undefined &&
        getSidebar().getHostFacade().getAgentLink(owner, sender.kind)?.sessionId ===
          sender.sessionId
      );
    },
    resolveInboundAgent: (sender, selection) =>
      getSidebar().getHostFacade().routeInboundAgent(sender, selection),
    showMovedNotice: (conversationId, message) =>
      getSidebar().getHostFacade().showConversationNotice(conversationId, message),
    isFocused: () => vscode.window.state.focused,
    configuredModels: () => busModelIds(getConfig()),
    relay: mesh.relay,
    relayAgent: makeAgentToAgentRelay(
      () => getSidebar().getHostFacade(),
      busPaths().root,
      workspaceRoot,
      askRuntime,
    ),
    // F-06: a `priority=steer` message interrupts the recipient's active turn.
    steer: mesh.steer,
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
    awaitingAnswerFrom: (from) => awaitedAnswers.pendingFor(from),
    // A `--new` message needs a tab to exist. Ask the sidebar NOW whether one
    // could be opened, so the route can answer 409 with the reasons instead of
    // answering 202 and dropping the message in `drain()`.
    chatCapBlockers: (options) => getSidebar().getHostFacade().chatCapBlockers(options),
    validateFrom: mesh.validateFrom,
    // §10: an interactive Claude/Codex session supersedes a Forge-owned peer.
    join: async (alias, pid, thread) => {
      if (alias === 'claude') return joinClaude(busPaths().root, alias, pid);
      if (alias !== 'codex') return { ok: false, error: `cannot join as "${alias}"` };
      if (!thread || !/^[A-Za-z0-9._-]+$/.test(thread)) {
        return { ok: false, error: 'thread must be a non-empty Codex thread id' };
      }
      if (mesh.orchestrator.isBusy('codex')) {
        return { ok: false, error: 'the owned codex turn is busy; join again when it is idle' };
      }
      if (!(await mesh.provider.releaseForCodexJoin())) {
        return { ok: false, error: 'another Forge window owns the codex session' };
      }
      return joinCodex(busPaths().root, alias, thread);
    },
    // §11: `forge.sh who` — read-only projection of every participant and its
    // state. The host owns the truth: it reads the alias table, ownership
    // records and its own in-memory FIFO, plus the sidebar's streaming state
    // and the inbox depth. The client only formats the returned JSON.
    who: () =>
      projectWho({
        busRoot: busPaths().root,
        knownAliases: () => mesh.orchestrator.aliases(),
        isOwner: (alias) => mesh.provider.isOwner(alias),
        isBusy: (alias) => mesh.orchestrator.isBusy(alias),
        forgeBusy: () => {
          const status = getSidebar().getHostFacade().status();
          return status.streamingConversationIds.includes(status.activeConversationId);
        },
        forgeInboxDepth: () => inbox.pending,
        claudeSessions: () => readClaudeSessions(),
      }),
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
    handleCommand: async (text) => {
      const cmd = parseMeshCommand(text);
      if (!cmd) return { ok: false as const, error: 'not a recognised mesh command' };
      try {
        const reply = await mesh.orchestrator.handleCommand(cmd);
        return { ok: true as const, reply };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
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
