/**
 * Builds the `ForgeHostFacade` the remote runtime and other extensions drive.
 *
 * Split out of `SidebarProvider`'s constructor: this is construction, not
 * behaviour — every entry forwards to a collaborator `wireSidebar` already built.
 */

import type { IBackendPool } from '../backend/BackendPool';
import { findConversation, type SidebarRuntime } from './sessionTypes';
import type { SidebarRuntimeParts } from './sidebarWiring';
import type { UserQuestionService } from './UserQuestionService';
import type { UserNotificationService } from './UserNotificationService';
import { SidebarHostFacade, type ForgeHostFacade } from './ForgeHostFacade';
import { get } from '../agentLinks/chatAgentLinks';
import { resolveInboundAgentTarget } from '../agentLinks/inboundAgentRouting';
import type { AskAgentRequest, AskAgentResult } from '../agentLinks/askAgentService';
import type { AgentLink } from '../agentLinks/chatAgentLinks';
import { reportedContextTokens, scaleContextParts } from '../util/contextBudget';

export interface SidebarFacadeDeps {
  runtime: SidebarRuntimeParts;
  getSidebar: () => SidebarRuntime;
  pool: IBackendPool;
  questions: UserQuestionService;
  notifications: UserNotificationService;
  /** Save one chat after its Clanker flag is written: a toggle has no turn running
   *  to carry the save, so whoever armed the chat has to make it. */
  persistConversation: (conversationId: string) => void;
  interrupt: (conversationId: string) => Promise<void>;
  unloadModels: () => Promise<void>;
  restartModel: (modelName: string) => Promise<void>;
  workspaceRoot: string | undefined;
  persistSession: () => void;
  postSessionSync: () => void;
  postConversationNotice: (conversationId: string, message: string) => void;
  askAgent: (
    conversationId: string,
    request: AskAgentRequest,
    signal: AbortSignal,
    onSessionLinked?: (link: AgentLink) => void,
    onAccepted?: (link: AgentLink) => void,
  ) => Promise<AskAgentResult>;
  cancelAgentAsk?: (conversationId: string) => void;
}

export function createSidebarHostFacade(deps: SidebarFacadeDeps): ForgeHostFacade {
  const { agentLoop, slashHandler, tabs, send, requestChains, budget, turnSpeeds } = deps.runtime;
  const { questions, notifications } = deps;
  return new SidebarHostFacade({
    createConversation: (options) => {
      const conversation = tabs.create(
        options.activate === undefined ? {} : { activate: options.activate },
      );
      if (conversation && options.openedBy) {
        conversation.opened_by = options.openedBy;
        // The worker runs under the rules of the chat that opened it; only an owner-armed chat can pass Clanker on.
        if (agentLoop.getClankerMode(options.openedBy))
          agentLoop.setClankerMode(conversation.id, true);
        deps.persistSession();
        deps.postSessionSync();
      }
      return conversation;
    },
    restoreConversation: (conversationId, options) => {
      if (!tabs.hasConversation(conversationId)) {
        throw new Error('Forge: conversation could not be restored.');
      }
      return tabs.restore(conversationId, options);
    },
    // Every send that arrives through the facade came from outside the webview
    // -- a paired chat, or another extension -- so its prompt has no bubble
    // unless the pipeline draws one.
    send: (conversationId, text, attachments, options) =>
      send.send(
        text,
        attachments,
        conversationId,
        options?.sender ? { sender: options.sender } : undefined,
        {
          ...(options?.remoteRequestId ? { remoteRequestId: options.remoteRequestId } : {}),
          echoPrompt: true,
        },
      ),
    runContactPrompt: (text, systemPromptText, options) =>
      agentLoop.runContactPrompt(text, systemPromptText, options),
    cancelContactPrompts: () => agentLoop.cancelContactPrompts(),
    cancel: async (conversationId) => {
      requestChains.markCancelling(conversationId);
      deps.cancelAgentAsk?.(conversationId);
      await agentLoop.cancel(conversationId);
    },
    interrupt: (conversationId) => deps.interrupt(conversationId),
    queueIntent: (conversationId) => requestChains.suppressContinuation(conversationId),
    addApprovalSink: (sink) => agentLoop.addApprovalSink(sink),
    pendingApprovalForConversation: (conversationId) =>
      agentLoop.pendingApprovalForConversation(conversationId),
    hasPendingQuestion: (conversationId) => questions.hasPending(conversationId),
    resolveApproval: (id, approved) => agentLoop.resolveConfirmation(id, approved),
    resetApprovals: (conversationId) => slashHandler.resetApprovals(conversationId),
    addQuestionSink: (sink) => questions.addSink(sink),
    answerQuestion: (id, text) => questions.answer(id, text),
    answerQuestionStructured: (id, answer) => questions.answerStructured(id, answer),
    skipQuestion: (id) => questions.skip(id),
    dismissQuestion: (id) => questions.dismiss(id),
    getPendingApproval: () => agentLoop.pendingApproval(),
    getActiveConversationId: () => deps.getSidebar().activeConversationId,
    getOpenConversations: () => deps.getSidebar().conversations,
    getArchivedConversations: () => deps.getSidebar().history,
    getRequestChains: () => requestChains.status(),
    getStreamingConversationIds: () => agentLoop.getStreamingIds(),
    getModelDemandConversationIds: () => agentLoop.getModelDemandIds(),
    getSessionActiveMs: (conversation) => agentLoop.getSessionActiveMs(conversation),
    // The cap question a transport must be able to ask BEFORE it wants a chat:
    // the agent bus pre-flights a `--new` message against this so a sender gets
    // a real refusal instead of a 202 and silence.
    capBlockers: (options) => tabs.capBlockers(options),
    routeInboundAgent: async (sender, selection) => {
      const result = resolveInboundAgentTarget({
        sidebar: deps.getSidebar(),
        sender,
        selection,
        ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
        createChat: () => tabs.create({ activate: true }),
        restoreChat: (id) => tabs.restore(id, { activate: true }),
        persist: deps.persistSession,
      });
      deps.postSessionSync();
      return result;
    },
    getAgentLink: (conversationId, kind) => {
      const state = deps.getSidebar();
      const chat = [...state.conversations, ...state.history].find(
        (item) => item.id === conversationId,
      );
      return chat ? get(chat, kind) : undefined;
    },
    askAgent: (conversationId, request, signal, onSessionLinked, onAccepted) =>
      deps.askAgent(conversationId, request, signal, onSessionLinked, onAccepted),
    showConversationNotice: deps.postConversationNotice,
    clankerMode: (conversationId) => agentLoop.getClankerMode(conversationId),
    // Per chat, and saved with that chat: the flag is the chat's own record, so
    // arming one chat no longer arms every tab in the window, and a phone and the
    // sidebar cannot disagree about what a window reload means. The save is here
    // because a `/clanker` that arrives from a phone has no turn to carry it.
    setClankerMode: (conversationId, on) => {
      agentLoop.setClankerMode(conversationId, on);
      if (findConversation(deps.getSidebar(), conversationId))
        deps.persistConversation(conversationId);
    },
    // Any conversation, not just the active one — the bar renders the active tab
    // only, but a remote chat can be bound to a background conversation and
    // still needs a truthful meter.
    contextBudget: (conversationId) => {
      const conv = findConversation(deps.getSidebar(), conversationId);
      return conv ? budget.resolvedSnapshot(conv) : undefined;
    },
    contextBreakdown: (conversationId) => {
      const conv = findConversation(deps.getSidebar(), conversationId);
      const parts = conv?.contextTrimState?.lastRequestParts;
      return conv && parts ? scaleContextParts(parts, reportedContextTokens(conv)) : undefined;
    },
    onCompactionEvent: (listener) => slashHandler.onCompactionEvent(listener),
    onHostActivity: (listener) => slashHandler.onHostActivity(listener),
    emitHostActivity: (event) => slashHandler.emitActivity(event),
    hostActivityListenerCount: () => slashHandler.hostActivityListenerCount(),
    onUserNotification: (sink) => notifications.addSink(sink),
    setReachProbe: (probe) => notifications.setReachProbe(probe),
    // The line is taken here, at delivery time, and only once: a chat-originated
    // turn's answer arrives through the queue drain, a sidebar turn's through the
    // mirrored echo, and whichever got there first keeps the speed.
    takeTurnSpeedLine: (conversationId) => turnSpeeds.takeLine(conversationId),
    onAgentProgress: (listener) => agentLoop.onAgentProgress(listener),
    // The retitle job's write. It goes through `tabs.rename`, the same path the
    // webview rename box uses, so an automatic name moves the in-memory list,
    // the archive index and the body files together instead of only one of
    // them. `auto` is what stops the job proposing the same name next run.
    applyAutoTitle: (conversationId, title) => {
      if (!tabs.hasConversation(conversationId)) return false;
      tabs.rename(conversationId, title, 'auto');
      return true;
    },
    compact: (conversationId, options) =>
      slashHandler.compactConversation(conversationId, {
        auto: false,
        ...(options?.trigger ? { trigger: options.trigger } : {}),
        ...(options?.remoteOrigin ? { remoteOrigin: options.remoteOrigin } : {}),
      }),
    setConversationModel: (conversationId, modelName) =>
      tabs.setModelById(conversationId, modelName),
    unloadModels: () => deps.unloadModels(),
    unloadConversationModel: (conversationId) => tabs.unloadModelOf(conversationId),
    restartModel: (modelName) => deps.restartModel(modelName),
    backendProcesses: () => deps.pool.backendProcesses(),
  });
}
