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
import { SlashCommandHandler } from './SlashCommandHandler';
import { wireTurnMirror } from './turnMirrorWiring';
import { runCompaction, type CompactionDeps } from './CompactionService';
import { runAddressedAutoCompact } from './autoCompactionPolicy';
import { runManualCompactResume } from './compactionPolicy';
import { compactMidTurn } from './midTurnCompaction';
import { isContextExhaustionReason } from '../agent/truncationRecovery';
import { ContextBudgetPublisher } from './ContextBudgetPublisher';
import { ConversationTabs } from './ConversationTabs';
import type { ChatAttachmentStore } from './ChatAttachmentStore';
import { SendPipeline } from './SendPipeline';
import { opResetReportedContext } from './ConversationOps';
import { snapshotRepoState } from './repoSnapshot';
import { listMemoryKeys } from '../tools/memoryTools';
import { RequestChainLifecycle } from './RequestChainLifecycle';
import { MidTurnInbox } from '../agent/MidTurnInbox';
import { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import { unattendedConversations } from './unattendedConversations';

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
  persistSession: () => void;
  /** Writes only the active-conversation pointer — see `saveActiveConversationId`. */
  persistActiveId: () => void;
  baseOf: (id: string | null | undefined) => string | null;
  reindexCodebase: () => Promise<void>;
  newConversation: () => Promise<void>;
  clearMessages: () => void;
  submitPrompt: (text: string) => Promise<void>;
  undo: () => Promise<string[]>;
  keep: () => Promise<void>;
  rememberClankerMode: (on: boolean) => void;
  /** Sole owner of the unload sequence; the slash command routes through it. */
  unloadModels: () => Promise<void>;
  unloadActiveModel: () => Promise<{ model: string; wasLoaded: boolean }>;
  isConversationQueued: (id: string) => boolean | undefined;
  isRemoteEvictionClear: (id: string) => boolean;
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
}

export interface SidebarRuntimeParts {
  agentLoop: AgentLoop;
  slashHandler: SlashCommandHandler;
  budget: ContextBudgetPublisher;
  tabs: ConversationTabs;
  send: SendPipeline;
  requestChains: RequestChainLifecycle;
  midTurnInbox: MidTurnInbox;
  /** Composes the sidebar inbox and the remote queue into one mid-turn drain. */
  tellDrain: MidTurnTellDrain;
}

export interface ConversationEvictionSignals {
  streaming: boolean;
  activeRequestChain: boolean;
  unattended: boolean;
  pendingApprovalActive: boolean;
  pendingApprovalQueued: boolean;
  pendingQuestion: boolean;
  unattributedRequest: boolean;
  hostQueue: boolean | undefined;
  webviewQueue: boolean;
  beforeWebviewQueueReport: boolean;
  remoteRuntimeUnavailable: boolean;
  remoteBinding: boolean;
  remoteIntakeQueue: boolean;
  /** Keep/Undo still undecided: archiving would hide the only way to undo. */
  undecidedChanges: boolean;
}

export function isConversationEvictable(signals: ConversationEvictionSignals): boolean {
  return !Object.values(signals).some((signal) => signal === true || signal === undefined);
}

export function wireSidebar(host: SidebarHost, parts: SidebarParts): SidebarRuntimeParts {
  const { pool, checkpoints, toolRegistry, failureTracker, events, workspaceState } = parts;
  const requestChains = new RequestChainLifecycle();
  const midTurnInbox = new MidTurnInbox();
  // One composer for every door. The sidebar inbox registers first so its tells
  // drain ahead of any remote claim; the remote source is added by extension.ts
  // once the RemoteRuntime's store and auth exist.
  const tellDrain = new MidTurnTellDrain();

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
    parts.cliSessions,
  );
  if (workspaceState.get<boolean>('forge.clankerMode', false)) agentLoop.setClankerMode(true);
  tellDrain.registerSource('sidebar', (conversationId) =>
    Promise.resolve({
      messages: midTurnInbox.drain(conversationId).map((tell) => ({
        role: 'user',
        content: tell.text,
        midTurn: true,
      })),
    }),
  );
  agentLoop.setMidTurnTellDrainer((conversationId) => tellDrain.drain(conversationId));

  const budget = new ContextBudgetPublisher({
    getConfig: host.getConfig,
    getSidebar: host.getSidebar,
    post: host.post,
    baseOf: host.baseOf,
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
    logCompaction: (conv, entry) => send.logCompaction(conv.id, entry),
    compactionMetrics: (conv) => {
      const { max } = budget.snapshot(conv);
      const at = host.getConfig().auto_compact?.at;
      return { max, ...(at !== undefined ? { threshold: at } : {}) };
    },
    runPromptToMarkdown: (text, conversationId, options) =>
      agentLoop.runPromptToMarkdown(text, conversationId, options),
    isStreaming: (conversationId) => agentLoop.isStreamingConv(conversationId),
    beginCompaction: (convId) => agentLoop.beginBackgroundWork(convId),
    snapshotRepoState,
    listMemoryKeys: () => listMemoryKeys(workspaceState),
    emitCompactionEvent: (event) => {
      for (const listener of slashHandler.compactionListeners) listener(event);
    },
  };

  const slashHandler = new SlashCommandHandler({
    ...compactionDeps,
    getConfig: host.getConfig,
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
    incompleteTurnReason: (conversationId) => agentLoop.incompleteTurnReason(conversationId),
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
    toggleClanker: () => {
      const on = agentLoop.toggleClanker();
      host.rememberClankerMode(on);
      return on;
    },
  });

  // Keeps the ctx bar and the HalluMeter bridge live during a turn instead of
  // frozen until it ends. Fired once per tool round, never per token.
  agentLoop.setContextChangedListener((convId) => budget.onTurnContextChanged(convId));
  agentLoop.setMidTurnCompactor((conv, request) =>
    compactMidTurn(
      {
        getConfig: host.getConfig,
        snapshot: (c) => budget.snapshot(c),
        compact: (conversationId) =>
          runCompaction(compactionDeps, conversationId, {
            auto: true,
            trigger: 'auto',
            midTurn: true,
          }),
      },
      conv,
      request,
    ),
  );
  // Flushed per round too: a mesh run is one turn that can last an hour, and
  // a log written only at turn end showed nothing of it while it ran.
  agentLoop.setTranscriptChangedListener((convId) => {
    host.persistSession();
    host.postSessionSync();
    send.flushSessionLog(convId, true);
  });

  const send = new SendPipeline({
    getConfig: host.getConfig,
    getSidebar: host.getSidebar,
    getActive: host.getActive,
    agentLoop,
    requestChains,
    failureTracker,
    events,
    post: host.post,
    persistSession: host.persistSession,
    postSessionSync: host.postSessionSync,
    evaluateAfterTurn: (conv, chain) => budget.evaluateAfterTurn(conv, chain),
    resetContextWarning: (conversationId) => budget.resetWarning(conversationId),
    attachmentStore: parts.attachmentStore,
    midTurnInbox,
  });

  const tabs = new ConversationTabs({
    isStreaming: () => agentLoop.streaming,
    getConfig: host.getConfig,
    getSidebar: host.getSidebar,
    setSidebar: host.setSidebar,
    setActiveModel: host.setActiveModel,
    persistSession: host.persistSession,
    postModels: host.postModels,
    postSessionSync: host.postSessionSync,
    pool,
    agentLoop,
    requestChains,
    checkpoints,
    failureTracker,
    events,
    post: host.post,
    baseOf: host.baseOf,
    refreshUi: (options) => {
      if (options?.pointerOnly) host.persistActiveId();
      else host.persistSession();
      host.postModels();
      host.postSessionSync();
      host.postTokenBudget();
    },
    isConversationEvictable: (id) => {
      const queued = host.isConversationQueued(id);
      const approvals = agentLoop.pendingApprovalConversationIds();
      const questions = parts.questions.pendingConversationIds();
      const remote = host.isRemoteEvictionClear(id);
      const chains = requestChains.status();
      return isConversationEvictable({
        streaming: agentLoop.isStreamingConv(id),
        activeRequestChain: chains.some((chain) => chain.conversationId === id),
        unattended: unattendedConversations.has(id),
        pendingApprovalActive: approvals.has(id),
        pendingApprovalQueued: approvals.has(id),
        pendingQuestion: parts.questions.hasPending(id),
        unattributedRequest: approvals.has('') || questions.has(''),
        hostQueue: queued,
        webviewQueue: queued === true,
        beforeWebviewQueueReport: queued === undefined,
        remoteRuntimeUnavailable: remote === undefined,
        remoteBinding: remote,
        remoteIntakeQueue: remote,
        undecidedChanges: checkpoints.canUndo(id),
      });
    },
  });

  // Last, because it needs both halves: the events object AgentLoop decorates
  // and the slashHandler that owns the activity listeners a transport hangs
  // off. Decorating rather than emitting from the turn path keeps every
  // outbound hook subscribed in one place.
  wireTurnMirror(events, {
    lookup: (id) => host.getSidebar().conversations.find((conv) => conv.id === id),
    emit: (event) => slashHandler.emitActivity(event),
    endProgress: (id, ok) => agentLoop.reportProgress({ conversationId: id, kind: 'end', ok }),
    willAutoResume: (message) => {
      const auto = host.getConfig().auto_compact;
      return auto?.enabled === true && auto.resume !== false && isContextExhaustionReason(message);
    },
  });

  // The session timer resolves conversation ids through this lookup.
  agentLoop.setConversationLookup((id) => findConversation(host.getSidebar(), id));
  // Lets a turn state, in its own context block, whether anyone is listening
  // from a phone. Routed through the notification service rather than the
  // remote controller: that class already owns "can I reach the user".
  agentLoop.setRemoteReach((id) => parts.notifications.reach(id));
  // The sidebar's own seat at the question table. Registered at construction,
  // not when the view resolves, because the sink must exist before the first
  // turn; `presentsLocally` is what makes it conditional, so a window whose view
  // has never been resolved still falls back to the VS Code input box.
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

  return { agentLoop, slashHandler, budget, tabs, send, requestChains, midTurnInbox, tellDrain };
}
