/**
 * Builds the `ForgeHostFacade` the remote runtime and other extensions drive.
 *
 * Split out of `SidebarProvider`'s constructor: this is construction, not
 * behaviour — every entry forwards to a collaborator `wireSidebar` already built.
 */

import type * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import { findConversation, type SidebarRuntime } from './sessionTypes';
import type { SidebarRuntimeParts } from './sidebarWiring';
import type { UserQuestionService } from './UserQuestionService';
import type { UserNotificationService } from './UserNotificationService';
import { SidebarHostFacade, type ForgeHostFacade } from './ForgeHostFacade';

export interface SidebarFacadeDeps {
  runtime: SidebarRuntimeParts;
  getSidebar: () => SidebarRuntime;
  pool: IBackendPool;
  questions: UserQuestionService;
  notifications: UserNotificationService;
  workspaceState: vscode.Memento;
  interrupt: (conversationId: string) => Promise<void>;
  unloadModels: () => Promise<void>;
  restartModel: (modelName: string) => Promise<void>;
}

export function createSidebarHostFacade(deps: SidebarFacadeDeps): ForgeHostFacade {
  const { agentLoop, slashHandler, tabs, send, requestChains, budget } = deps.runtime;
  const { questions, notifications } = deps;
  return new SidebarHostFacade({
    createConversation: (options) => tabs.create(options),
    restoreConversation: (conversationId, options) => tabs.restore(conversationId, options),
    // Every send that arrives through the facade came from outside the webview
    // -- a paired chat, or another extension -- so its prompt has no bubble
    // unless the pipeline draws one.
    send: (conversationId, text, attachments, options) =>
      send.send(text, attachments, conversationId, undefined, { ...options, echoPrompt: true }),
    runContactPrompt: (text, systemPromptText, options) =>
      agentLoop.runContactPrompt(text, systemPromptText, options),
    cancelContactPrompts: () => agentLoop.cancelContactPrompts(),
    cancel: async (conversationId) => {
      requestChains.markCancelling(conversationId);
      await agentLoop.cancel(conversationId);
    },
    interrupt: (conversationId) => deps.interrupt(conversationId),
    queueIntent: (conversationId) => requestChains.suppressContinuation(conversationId),
    addApprovalSink: (sink) => agentLoop.addApprovalSink(sink),
    resolveApproval: (id, approved) => agentLoop.resolveConfirmation(id, approved),
    addQuestionSink: (sink) => questions.addSink(sink),
    answerQuestion: (id, text) => questions.answer(id, text),
    dismissQuestion: (id) => questions.dismiss(id),
    getPendingApproval: () => agentLoop.pendingApproval(),
    getActiveConversationId: () => deps.getSidebar().activeConversationId,
    getOpenConversations: () => deps.getSidebar().conversations,
    getArchivedConversations: () => deps.getSidebar().history,
    getRequestChains: () => requestChains.status(),
    getStreamingConversationIds: () => agentLoop.getStreamingIds(),
    clankerMode: () => agentLoop.getClankerMode(),
    // Remote and sidebar arming persist identically, to workspaceState. The
    // asymmetry that used to live here — remote ON in memory only, so it died at
    // the next reload — made the state unexplainable from either surface: a
    // phone that armed clanker and a sidebar toggle that armed clanker disagreed
    // about what a reload meant, and the owner could only find out by
    // reloading. One rule, stated in both help texts, beats a safety default
    // nobody can see.
    setClankerMode: (on) => {
      agentLoop.setClankerMode(on);
      void deps.workspaceState.update('forge.clankerMode', on);
    },
    // Any conversation, not just the active one — the bar renders the active tab
    // only, but a remote chat can be bound to a background conversation and
    // still needs a truthful meter.
    contextBudget: (conversationId) => {
      const conv = findConversation(deps.getSidebar(), conversationId);
      return conv ? budget.resolvedSnapshot(conv) : undefined;
    },
    onCompactionEvent: (listener) => slashHandler.onCompactionEvent(listener),
    onHostActivity: (listener) => slashHandler.onHostActivity(listener),
    emitHostActivity: (event) => slashHandler.emitActivity(event),
    onUserNotification: (sink) => notifications.addSink(sink),
    setReachProbe: (probe) => notifications.setReachProbe(probe),
    onAgentProgress: (listener) => agentLoop.onAgentProgress(listener),
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
