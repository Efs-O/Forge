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
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
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
import type { CompactionEvent } from './CompactionService';
import { ContextBudgetPublisher } from './ContextBudgetPublisher';
import { ConversationTabs } from './ConversationTabs';
import { SendPipeline } from './SendPipeline';
import { opResetReportedContext } from './ConversationOps';
import { snapshotRepoState } from './repoSnapshot';
import { RequestChainLifecycle } from './RequestChainLifecycle';
import type { RequestChainContext } from './RequestChainLifecycle';
import type { ContextThresholdAction } from './ContextBudgetPublisher';

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
  baseOf: (id: string | null | undefined) => string | null;
  autoCompact: (
    conv: ConversationRuntime,
    chain: RequestChainContext,
  ) => Promise<ContextThresholdAction | undefined>;
  resumeAfterManualCompact: (conversationId: string, reason: string) => Promise<void>;
  emitCompactionEvent: (event: CompactionEvent) => void;
  reindexCodebase: () => Promise<void>;
  newConversation: () => Promise<void>;
  clearMessages: () => void;
  submitPrompt: (text: string) => Promise<void>;
  undo: () => Promise<string[]>;
  keep: () => Promise<void>;
  rememberClankerMode: (on: boolean) => void;
  /** Sole owner of the unload sequence; the slash command routes through it. */
  unloadModels: () => Promise<void>;
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
}

export interface SidebarRuntimeParts {
  agentLoop: AgentLoop;
  slashHandler: SlashCommandHandler;
  budget: ContextBudgetPublisher;
  tabs: ConversationTabs;
  send: SendPipeline;
  requestChains: RequestChainLifecycle;
}

export function wireSidebar(host: SidebarHost, parts: SidebarParts): SidebarRuntimeParts {
  const { pool, checkpoints, toolRegistry, failureTracker, events, workspaceState } = parts;
  const requestChains = new RequestChainLifecycle();

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

  const budget = new ContextBudgetPublisher({
    getConfig: host.getConfig,
    getSidebar: host.getSidebar,
    post: host.post,
    baseOf: host.baseOf,
    autoCompact: (conv, chain) => host.autoCompact(conv, chain),
    manualCompact: () => void slashHandler.handle('compact'),
    incompleteTurnReason: (convId) => agentLoop.incompleteTurnReason(convId),
  });

  const slashHandler = new SlashCommandHandler({
    getConfig: host.getConfig,
    unloadModels: host.unloadModels,
    pool,
    events,
    reindexCodebase: host.reindexCodebase,
    newConversation: host.newConversation,
    clearMessages: host.clearMessages,
    submitPrompt: host.submitPrompt,
    undo: host.undo,
    keep: host.keep,
    post: host.post,
    getActiveConv: host.getActive,
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
    incompleteTurnReason: (conversationId) => agentLoop.incompleteTurnReason(conversationId),
    resumeAfterManualCompact: (conversationId, reason) =>
      host.resumeAfterManualCompact(conversationId, reason),
    emitCompactionEvent: (event) => host.emitCompactionEvent(event),
    toggleClanker: () => {
      const on = agentLoop.toggleClanker();
      host.rememberClankerMode(on);
      return on;
    },
  });

  // Keeps the ctx bar and the HalluMeter bridge live during a turn instead of
  // frozen until it ends. Fired once per tool round, never per token.
  agentLoop.setContextChangedListener((convId) => budget.onTurnContextChanged(convId));
  agentLoop.setTranscriptChangedListener(() => {
    host.persistSession();
    host.postSessionSync();
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
  });

  const tabs = new ConversationTabs({
    workspaceState,
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
    checkpoints,
    failureTracker,
    events,
    post: host.post,
    baseOf: host.baseOf,
    refreshUi: () => {
      host.persistSession();
      host.postModels();
      host.postSessionSync();
      host.postTokenBudget();
    },
  });

  // Last, because it needs both halves: the events object AgentLoop decorates
  // and the slashHandler that owns the activity listeners a transport hangs
  // off. Decorating rather than emitting from the turn path keeps every
  // outbound hook subscribed in one place.
  wireTurnMirror(events, {
    lookup: (id) => host.getSidebar().conversations.find((conv) => conv.id === id),
    emit: (event) => slashHandler.emitActivity(event),
  });

  return { agentLoop, slashHandler, budget, tabs, send, requestChains };
}
