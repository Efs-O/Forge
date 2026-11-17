/**
 * Builds the collaborators `SidebarProvider` coordinates.
 *
 * Split out of the provider so its constructor states *what* the sidebar is
 * made of rather than how each part is wired. Everything the parts need from
 * the provider arrives through `SidebarHost`, which is the provider's own
 * surface expressed as callbacks — no part reaches back into it directly.
 */

import type * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import { findConversation, type ConversationRuntime, type SidebarRuntime } from './sessionTypes';
import type { UserQuestionService } from './UserQuestionService';
import type { UserNotificationService } from './UserNotificationService';
import { buildQuestionMessage } from './sidebarPayloads';
import type { IBackendPool } from '../backend/BackendPool';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolFailureTracker } from '../tools/StripTools';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { DiffDecorations } from './DiffDecorations';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import { AgentLoop, type SidebarProviderEvents } from './AgentLoop';
import { makeAgentLoopTurnDependencies } from './turnServicesAssembly';
import { SlashCommandHandler } from './SlashCommandHandler';
import { wireTurnMirror } from './turnMirrorWiring';
import { wireTurnEndNotes } from './turnEndNotes';
import { isCliAgentModel } from '../jobs/cliAgentGate';
import { runMidTurnCompaction, type CompactionDeps } from './CompactionService';
import { runAddressedAutoCompact } from './autoCompactionPolicy';
import { runManualCompactResume } from './compactionPolicy';
import { compactMidTurn } from './midTurnCompaction';
import { isContextExhaustionReason } from '../agent/truncationRecovery';
import { ContextBudgetPublisher } from './ContextBudgetPublisher';
import type { ConversationTabs } from './ConversationTabs';
import type { ChatAttachmentStore } from './ChatAttachmentStore';
import { SendPipeline } from './SendPipeline';
import { GateEventLog } from './gateEventLog';
import { opResetReportedContext } from './ConversationOps';
import { snapshotRepoState } from './repoSnapshot';
import { listMemoryKeys } from '../tools/memoryTools';
import { resolveRequestModel } from '../config/ConfigResolver';
import { createCompactionCounter } from './compactionCounter';
import { reasoningReserve } from '../util/contextBudget';
import { RequestChainLifecycle } from './RequestChainLifecycle';
import { MidTurnInbox } from '../agent/MidTurnInbox';
import { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import { ElapsedTimeNote } from '../agent/elapsedTimeNote';
import { randomUUID } from 'crypto';
import { createSidebarPromptRouter, type SidebarPromptRouter } from './backgroundExitNotice';
import { registerWorkerChatWake } from './workerChatWake';
import { createTurnSpeedLedger, type TurnSpeedLedger } from '../sessions/turnSpeedTotals';
import { unattendedConversations } from './unattendedConversations';
import type { ArchivedSessions } from './ArchivedSessions';
import { createConversationEvictionSignals } from './conversationEvictionSignals';
import type { ConversationRetentionScheduler } from './ConversationRetentionScheduler';
import { wireConversationTabs } from './conversationTabsWiring';
import { withResumedRunReconciliation } from '../jobs/resumedRun';
import { wireMidTurnTells } from './midTurnTellWiring';
/** What the provider lends its collaborators. */
export interface SidebarHost {
  getConfig: () => ForgeConfig;
  setActiveModel: (name: string | null) => void;
  getSidebar: () => SidebarRuntime;
  setSidebar: (next: SidebarRuntime) => void;
  getActive: () => ConversationRuntime;
  getView: () => vscode.WebviewView | undefined;
  post: (msg: HostToWebview) => void;
  postModels: () => void;
  postSessionSync: () => void;
  postTokenBudget: () => void;
  persistSession: (changedId?: string) => void | Promise<boolean>;
  persistSidebar: (next: SidebarRuntime) => Promise<boolean>;
  /** Writes only the active-conversation pointer — see `saveActiveConversationId`. */
  persistActiveId: () => void;
  baseOf: (id: string | null | undefined) => string | null;
  reindexCodebase: () => Promise<void>;
  newConversation: () => Promise<void>;
  clearMessages: () => void;
  submitPrompt: (text: string) => Promise<void>;
  undo: () => Promise<string[]>;
  keep: () => Promise<void>;
  /** Sole owner of the unload sequence; the slash command routes through it. */
  unloadModels: () => Promise<void>;
  unloadActiveModel: () => Promise<{ model: string; wasLoaded: boolean; serverStopped?: boolean }>;
  isConversationQueued: (id: string) => boolean | undefined;
  isConversationDrafted: (id: string) => boolean | undefined;
  /**
   * Whether remote state (a chat binding, queued remote messages) pins this
   * conversation: `undefined` while the remote store has not loaded, `false`
   * when no remote runtime is configured.
   */
  remoteEvictionBlocks: (id: string) => boolean | undefined;
}

/** The construction-time collaborators, straight from the provider's ctor. */
export interface SidebarParts {
  pool: IBackendPool;
  checkpoints: CheckpointStack;
  toolRegistry: ToolRegistry;
  failureTracker: ToolFailureTracker;
  codeLens: KeepUndoCodeLensProvider;
  diffDecorations: DiffDecorations;
  events: SidebarProviderEvents;
  workspaceState: vscode.Memento;
  // Undefined is meaningful for each of these — the provider's own optional
  // constructor parameters are passed straight through.
  templateEngine: TemplateEngine | undefined;
  forgeLoader: ForgeInstructionsLoader | undefined;
  secrets: vscode.SecretStorage | undefined;
  workspaceRoot: string | undefined;
  getConfigPath: (() => string) | undefined;
  cliSessions: CliSessionRegistry | undefined;
  attachmentStore: ChatAttachmentStore | undefined;
  questions: UserQuestionService;
  notifications: UserNotificationService;
  archivedSessions?: ArchivedSessions;
}

export interface SidebarRuntimeParts {
  agentLoop: AgentLoop;
  slashHandler: SlashCommandHandler;
  budget: ContextBudgetPublisher;
  tabs: ConversationTabs;
  retention: ConversationRetentionScheduler;
  send: SendPipeline;
  requestChains: RequestChainLifecycle;
  midTurnInbox: MidTurnInbox;
  /** Composes the sidebar inbox and the remote queue into one mid-turn drain. */
  tellDrain: MidTurnTellDrain;
  /** The one routing decision for a prompt: a busy chat's inbox, or a new turn. */
  promptRouter: SidebarPromptRouter;
  /** Each turn's server timings, summed as its requests settle, read by whoever
   *  delivers that turn's answer: only the turn runner knows what the turn cost. */
  turnSpeeds: TurnSpeedLedger;
}

export function wireSidebar(host: SidebarHost, parts: SidebarParts): SidebarRuntimeParts {
  const { pool, checkpoints, toolRegistry, failureTracker, events, workspaceState } = parts;
  const requestChains = new RequestChainLifecycle();
  const compactionCounter = createCompactionCounter({
    getConfig: host.getConfig,
    pool,
    secrets: parts.secrets,
  });
  const midTurnInbox = new MidTurnInbox();
  const tellDrain = new MidTurnTellDrain();
  // Forge's own tell: one note per task once it has been running a long time.
  const elapsedTimeNote = new ElapsedTimeNote(
    () => host.getConfig().elapsed_time_note?.after_minutes,
  );

  const agentLoop = new AgentLoop(
    pool,
    host.getConfig,
    toolRegistry,
    checkpoints,
    parts.codeLens,
    parts.diffDecorations,
    failureTracker,
    events,
    host.post,
    host.getView,
    parts.templateEngine,
    parts.forgeLoader,
    parts.secrets,
    parts.workspaceRoot,
    parts.getConfigPath,
    undefined,
    makeAgentLoopTurnDependencies(parts.workspaceState, parts.cliSessions),
  );
  wireMidTurnTells({
    tellDrain,
    midTurnInbox,
    elapsedTimeNote,
    post: host.post,
    setMidTurnTells: (services) => agentLoop.setMidTurnTells(services),
  });

  const budget = new ContextBudgetPublisher({
    getConfig: host.getConfig,
    getSidebar: host.getSidebar,
    post: host.post,
    baseOf: host.baseOf,
    admissionCompact: (conv) =>
      slashHandler.compactConversation(conv.id, { auto: true, trigger: 'admission' }),
    autoCompact: (conv, chain) =>
      runAddressedAutoCompact(
        {
          post: host.post,
          requestChains,
          compact: (conversationId) =>
            slashHandler.compactConversation(conversationId, { auto: true, trigger: 'auto' }),
          incompleteTurnReason: (conversationId) => agentLoop.incompleteTurnReason(conversationId),
          resumeEnabled: () => host.getConfig().auto_compact?.resume !== false,
        },
        conv,
        chain,
      ),
    manualCompact: () => void slashHandler.handle('compact'),
    incompleteTurnReason: (convId) => agentLoop.incompleteTurnReason(convId),
  });

  // One deps object for every compaction path: the slash command, the
  // post-turn trigger (through the slash handler) and mid-turn compaction.
  const compactionDeps: CompactionDeps = {
    post: host.post,
    getConversation: (conversationId) =>
      host.getSidebar().conversations.find((conv) => conv.id === conversationId),
    persistSession: host.persistSession,
    postSessionSync: host.postSessionSync,
    invalidateExactTokenBudget: (conv) => opResetReportedContext(conv),
    postTokenBudget: (conv) => budget.publish(conv),
    // `send` is constructed below; this closure only runs after a compaction,
    // which cannot happen before the pipeline exists.
    logCompaction: (conv, entry) => send.sessionLogs.logCompaction(conv.id, entry),
    logCompactionAttempt: (conv, entry) => send.sessionLogs.logCompactionAttempt(conv.id, entry),
    compactionMetrics: (conv) => {
      const { max } = budget.snapshot(conv);
      const config = host.getConfig();
      const at = config.auto_compact?.at;
      const modelName = conv.active_model ?? config.active_model;
      const model = modelName ? resolveRequestModel(config, modelName) : undefined;
      const reserve = model ? reasoningReserve(model) : 0;
      return {
        max,
        reasoningReserve: reserve,
        outputLimitTokens: model?.sampling?.max_tokens ?? 0,
        ...(at !== undefined ? { threshold: at } : {}),
      };
    },
    tokenCountMode: compactionCounter.mode,
    tokenCountEndpoint: compactionCounter.endpoint,
    countTokens: compactionCounter.count,
    runPromptToMarkdown: (text, conversationId, options) =>
      agentLoop.runPromptToMarkdown(text, conversationId, options),
    currentLocalTime: () => new Date().toLocaleString(),
    isStreaming: (conversationId) => agentLoop.isStreamingConv(conversationId),
    beginCompaction: (convId) => agentLoop.beginBackgroundWork(convId),
    snapshotRepoState,
    listMemoryKeys: () => listMemoryKeys(workspaceState),
    emitCompactionEvent: (event) => {
      for (const listener of slashHandler.compactionListeners) listener(event);
    },
    // A compaction drops Forge's internal notes from the summary, so the
    // elapsed-time clock restarts from here or a long task could read for
    // another hour unnoticed. Only a COMMITTED compaction reaches this dep.
    onCompacted: (conversationId) => elapsedTimeNote.compacted(conversationId),
  };
  const slashHandler = new SlashCommandHandler({
    ...compactionDeps,
    getConfig: host.getConfig,
    ...(parts.workspaceRoot ? { workspaceRoot: parts.workspaceRoot } : {}),
    ...(parts.getConfigPath ? { getConfigPath: parts.getConfigPath } : {}),
    unloadModels: host.unloadModels,
    unloadActiveModel: host.unloadActiveModel,
    pool,
    events,
    reindexCodebase: host.reindexCodebase,
    newConversation: host.newConversation,
    clearMessages: host.clearMessages,
    submitPrompt: host.submitPrompt,
    undo: host.undo,
    keep: host.keep,
    getActiveConv: host.getActive,
    getConversations: () => {
      const sidebar = host.getSidebar();
      return [...sidebar.conversations, ...sidebar.history];
    },
    incompleteTurnReason: (conversationId) => agentLoop.incompleteTurnReason(conversationId),
    isStreamingConv: (conversationId) => agentLoop.isStreamingConv(conversationId),
    resumeAfterManualCompact: (conversationId, reason) =>
      runManualCompactResume(
        {
          post: host.post,
          send: async (text, convId, options) => {
            await send.send(text, undefined, convId, options);
          },
        },
        conversationId,
        reason,
      ),
    toggleClanker: (conversationId) => {
      const on = !agentLoop.getClankerMode(conversationId);
      // The queue writes the chat's record; this save is the only one a toggle gets.
      agentLoop.setClankerMode(conversationId, on);
      host.persistSession(conversationId);
      return on;
    },
    resetApprovals: (conversationId) => tabs.resetApprovals(conversationId),
  });

  // Keeps the ctx bar and HalluMeter bridge live per round, not frozen until the turn ends.
  agentLoop.setContextChangedListener((convId) => budget.onTurnContextChanged(convId));
  agentLoop.setMidTurnCompactor((conv, request) =>
    compactMidTurn(
      {
        getConfig: host.getConfig,
        snapshot: (c) => budget.snapshot(c),
        compact: (conversationId, decisionTokens) =>
          runMidTurnCompaction(compactionDeps, conversationId, decisionTokens),
      },
      conv,
      request,
    ),
  );
  // Flushed per round too: a mesh run is one turn that can last an hour, and
  // a log written only at turn end showed nothing of it while it ran.
  agentLoop.setTranscriptChangedListener((convId) => {
    host.persistSession(convId);
    host.postSessionSync();
    send.sessionLogs.flushSessionLog(convId, true);
  });

  registerWorkerChatWake({
    openConversations: () => host.getSidebar().conversations,
    routeInternal: (text, id, origin) => promptRouter.routeInternal(text, id, origin),
  });
  const retentionRef: { current?: ConversationRetentionScheduler } = {};
  const send = new SendPipeline({
    getConfig: host.getConfig,
    getSidebar: host.getSidebar,
    getActive: host.getActive,
    agentLoop,
    requestChains,
    events,
    post: host.post,
    persistSession: host.persistSession,
    onConversationActivity: (id) => retentionRef.current?.markActivity(id),
    postSessionSync: host.postSessionSync,
    evaluateAfterTurn: withResumedRunReconciliation(budget),
    evaluateAtAdmission: (conv) => budget.evaluateAtAdmission(conv),
    resetContextWarning: (conversationId) => budget.resetWarning(conversationId),
    attachmentStore: parts.attachmentStore,
    midTurnInbox,
  });
  // One sum per conversation, opened and closed by `wireTurnMirror` below: this
  // listener is where every model request of every turn already passes.
  const turnSpeeds = createTurnSpeedLedger();
  agentLoop.setToolsOfferedListener((conversationId, names, fingerprint) =>
    send.sessionLogs.logToolsOffered(conversationId, names, fingerprint),
  );
  agentLoop.setRequestStatsListener((conversationId, capture) => {
    // Every request of a turn already passes here, so this is where the turn's
    // speed is built — not in the transport, which cannot see requests.
    turnSpeeds.record(conversationId, capture);
    send.sessionLogs.logRequestStats(conversationId, capture);
  });

  // One reading of the eviction gate, shared by the yes/no decision and the
  // explanation of a refusal. Both come from the same object so a reason can
  // never drift from the rule that produced it.
  const evictionSignals = createConversationEvictionSignals({
    isStreaming: (id) => agentLoop.isStreamingConv(id),
    isConversationQueued: (id) => host.isConversationQueued(id),
    isConversationDrafted: (id) => host.isConversationDrafted(id),
    remoteEvictionBlocks: (id) => host.remoteEvictionBlocks(id),
    pendingApprovalConversationIds: () => agentLoop.pendingApprovalConversationIds(),
    pendingQuestionConversationIds: () => parts.questions.pendingConversationIds(),
    hasPendingQuestion: (id) => parts.questions.hasPending(id),
    requestChainConversations: () => requestChains.status(),
    openConversations: () => host.getSidebar().conversations,
    isUnattended: (id) => unattendedConversations.has(id),
  });

  const { tabs, retention } = wireConversationTabs({
    host,
    parts,
    pool,
    checkpoints,
    failureTracker,
    events,
    agentLoop,
    requestChains,
    workspaceState,
    evictionSignals,
  });
  retentionRef.current = retention;

  // Wire last: this needs AgentLoop's events and slashHandler's listeners.
  wireTurnMirror(events, {
    lookup: (id) => host.getSidebar().conversations.find((conv) => conv.id === id),
    emit: (event) => slashHandler.emitActivity(event),
    endProgress: (id, outcome) =>
      agentLoop.reportProgress({ conversationId: id, kind: 'end', outcome }),
    willAutoResume: (message) => {
      const auto = host.getConfig().auto_compact;
      return auto?.enabled === true && auto.resume !== false && isContextExhaustionReason(message);
    },
    turnSpeeds,
  });

  // What the model is told about a turn the user stopped. Only an open chat
  // gets the note: an archived or evicted one has no next request to read it,
  // and a CLI agent's transcript belongs to the CLI, not to Forge.
  wireTurnEndNotes(events, {
    lookup: (id) => host.getSidebar().conversations.find((conv) => conv.id === id),
    isCliModel: (name) => isCliAgentModel(host.getConfig(), name),
  });

  // The session timer resolves conversation ids through this lookup.
  agentLoop.setConversationLookup((id) => findConversation(host.getSidebar(), id));
  // Lets a turn state, in its own context block, whether anyone is listening
  // from a phone. Routed through the notification service rather than the
  // remote controller: that class already owns "can I reach the user".
  agentLoop.setRemoteReach((id) => parts.notifications.reach(id));
  // Register the sidebar before the first turn; presentsLocally checks the view.
  parts.questions.addSink({
    asked: (event) => {
      host.post(buildQuestionMessage(event));
      host.postSessionSync();
    },
    answered: (event) => {
      host.post({ type: 'questionResolved', id: event.id });
      host.postSessionSync();
    },
    presentsLocally: () => host.getView() !== undefined,
  });
  agentLoop.addApprovalSink({
    requested: () => host.postSessionSync(),
    resolved: () => host.postSessionSync(),
  });
  // Log cards and refusals into the turn transcript without answering them.
  agentLoop.addApprovalSink(
    new GateEventLog({
      write: (row) => send.sessionLogs.logGate(row.conversation_id ?? '', row),
      now: () => Date.now(),
    }),
  );
  // Webview sends and background exit notices share this router, so a notice
  // reaches a busy chat exactly the way a typed message does.
  const promptRouter = createSidebarPromptRouter({
    activeId: () => host.getSidebar().activeConversationId,
    isReserved: (id) => requestChains.isReserved(id),
    addTell: (id, text, internal, tellId, createdAt, origin) =>
      midTurnInbox.add(id, {
        id: tellId ?? randomUUID(),
        text,
        ...(internal ? { internal: true } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(origin ? { origin } : {}),
      }),
    removeTell: (id, tellId) => midTurnInbox.remove(id, tellId),
    markSendNow: (id, tellId) => midTurnInbox.markSendNow(id, tellId),
    isStreaming: (id) => agentLoop.isStreamingConv(id),
    interruptForSteering: async (id) => {
      requestChains.markCancelling(id, 'interrupted');
      await agentLoop.interrupt(id);
    },
    send: (text, attachments, id, echo, internal, createdAt, onAdmitted, origin) =>
      send.send(
        text,
        attachments,
        id,
        { ...(internal ? { internal: true } : {}), ...(origin ? { origin } : {}) },
        {
          ...(echo ? { echoPrompt: true } : {}),
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(onAdmitted ? { onAdmitted } : {}),
        },
      ),
    isOpen: (id) => host.getSidebar().conversations.some((conversation) => conversation.id === id),
  });
  return {
    agentLoop,
    slashHandler,
    budget,
    tabs,
    retention,
    send,
    requestChains,
    midTurnInbox,
    tellDrain,
    promptRouter,
    turnSpeeds,
  };
}
