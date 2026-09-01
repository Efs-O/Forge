import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { perSlotContext, reportedContextTokens } from '../util/contextBudget';
import { expandAlias, mergeGroupsIntoModel, splitModelProfile } from '../config/ConfigResolver';
import type { HostToWebview, WebviewToHost, AttachmentData } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import { loadSidebarSession, saveSidebarSession } from './sessionTypes';
import { CheckpointStack } from '../checkpoint/CheckpointStack';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { DiffDecorations } from './DiffDecorations';
import { CheckpointReview } from './CheckpointReview';
import { ToolFailureTracker } from '../tools/StripTools';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { AgentLoop } from './AgentLoop';
import type { SidebarProviderEvents } from './AgentLoop';
import type { SlashCommandHandler } from './SlashCommandHandler';
import { wireSidebar } from './sidebarWiring';
import { reindexCodebase } from './reindexCommand';
import type { ContextBudgetPublisher } from './ContextBudgetPublisher';
import type { ConversationTabs } from './ConversationTabs';
import type { SendPipeline } from './SendPipeline';
import { routeWebviewMessage } from './webviewMessageRouter';
import { logWebviewDiagnostic } from './webviewDiagnostics';
import {
  buildModelsMessage,
  buildSessionMetrics,
  buildSessionSyncMessage,
} from './sidebarPayloads';
import { runManualCompactResume } from './compactionPolicy';
import type { CompactionPolicyDeps } from './compactionPolicy';
import { workspaceInfoMessage } from './workspaceInfo';
import { buildWebviewHtml } from './WebviewBuilder';
import type { IndexManager } from '../search/IndexManager';
import type { SessionTimeSnapshot } from '../vscode/SessionTimeStatusBar';
import type { RequestChainLifecycle } from './RequestChainLifecycle';
import type { RequestChainContext } from './RequestChainLifecycle';
import type { ContextThresholdAction } from './ContextBudgetPublisher';
import { runAddressedAutoCompact } from './autoCompactionPolicy';
import { SidebarHostFacade, type ForgeHostFacade } from './ForgeHostFacade';
import { ResidencyPoller } from './ResidencyPoller';
import type { UserQuestionService } from './UserQuestionService';
import type { UserNotificationService } from './UserNotificationService';

export type { SidebarProviderEvents };
/** Residency refresh while visible: cheap, but fast enough to avoid a stale dot. */
const RESIDENCY_POLL_MS = 1500;

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'forge.sidebar';

  private view?: vscode.WebviewView;
  /** Residency poll: see docs/plans/MODEL_READINESS_DOT_PLAN.md — why a tick, not an event; runs only while the sidebar is visible. */
  private sidebar: SidebarRuntime;
  private readonly failureTracker = new ToolFailureTracker();
  private readonly agentLoop: AgentLoop;
  private readonly slashHandler: SlashCommandHandler;
  private readonly review = new CheckpointReview();
  private readonly budget: ContextBudgetPublisher;
  private readonly tabs: ConversationTabs;
  private readonly send: SendPipeline;
  private readonly requestChains: RequestChainLifecycle;
  private readonly hostFacade: ForgeHostFacade;
  private readonly residency = new ResidencyPoller(
    () => this.pool.residencySignature(),
    () => this.postModels(),
    RESIDENCY_POLL_MS,
  );

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pool: IBackendPool,
    private config: ForgeConfig,
    private readonly checkpoints: CheckpointStack,
    toolRegistry: ToolRegistry,
    private readonly indexManager: IndexManager,
    // Required, and deliberately not defaulted: a defaulted instance would let a
    // caller silently own a second service, and ask_user's questions would then
    // never reach the facade the remote bridge subscribes to.
    private readonly questions: UserQuestionService,
    // Same reasoning as `questions`: one owner, so notify_user and the remote
    // bridge share a single fan-out.
    private readonly notifications: UserNotificationService,
    private readonly workspaceState: vscode.Memento,
    private readonly codeLens: KeepUndoCodeLensProvider,
    diffDecorations: DiffDecorations,
    templateEngine?: TemplateEngine,
    private readonly events: SidebarProviderEvents = {},
    forgeLoader?: ForgeInstructionsLoader,
    secrets?: vscode.SecretStorage,
    // Kept as a field so `postWorkspaceInfo` can tell a live root apart from
    // the one every by-value consumer was constructed with.
    private readonly workspaceRoot?: string,
    getConfigPath?: () => string,
    cliSessions?: CliSessionRegistry,
  ) {
    this.sidebar = loadSidebarSession(workspaceState);
    const runtime = wireSidebar(
      {
        getConfig: () => this.config,
        setActiveModel: (name) => {
          this.config.active_model = name;
        },
        getSidebar: () => this.sidebar,
        setSidebar: (next) => {
          this.sidebar = next;
        },
        getActive: () => this.getActive(),
        getView: () => this.view,
        post: (msg) => this.post(msg),
        postModels: () => this.postModels(),
        postSessionSync: () => this.postSessionSync(),
        postTokenBudget: () => this.postTokenBudget(),
        persistSession: () => this.persistSession(),
        baseOf: (id) => this.baseOf(id),
        autoCompact: (conv, chain) => this.autoCompact(conv, chain),
        resumeAfterManualCompact: (conversationId, reason) =>
          this.resumeAfterManualCompact(conversationId, reason),
        emitCompactionEvent: (event) => {
          for (const listener of this.slashHandler.compactionListeners) listener(event);
        },
        reindexCodebase: () => this.reindexCodebase(),
        newConversation: () => this.newConversation(),
        clearMessages: () => this.tabs.clearActive(),
        submitPrompt: (text) => this.submitPrompt(text),
        undo: () => this.undo(),
        keep: () => this.keep(),
        rememberClankerMode: (on) => void this.workspaceState.update('forge.clankerMode', on),
        unloadModels: () => this.unloadModels(),
      },
      {
        pool,
        checkpoints,
        toolRegistry,
        failureTracker: this.failureTracker,
        codeLens,
        diffDecorations,
        events,
        workspaceState,
        templateEngine,
        forgeLoader,
        secrets,
        workspaceRoot,
        getConfigPath,
        cliSessions,
      },
    );
    this.agentLoop = runtime.agentLoop;
    this.slashHandler = runtime.slashHandler;
    this.budget = runtime.budget;
    this.tabs = runtime.tabs;
    this.send = runtime.send;
    this.requestChains = runtime.requestChains;
    this.hostFacade = new SidebarHostFacade({
      createConversation: (options) => this.tabs.create(options),
      restoreConversation: (conversationId, options) => this.tabs.restore(conversationId, options),
      send: (conversationId, text, attachments, options) =>
        this.send.send(text, attachments, conversationId, undefined, options),
      cancel: async (conversationId) => {
        this.requestChains.markCancelling(conversationId);
        await this.agentLoop.cancel(conversationId);
      },
      interrupt: (conversationId) => this.interruptForSteering(conversationId),
      queueIntent: (conversationId) => this.requestChains.suppressContinuation(conversationId),
      addApprovalSink: (sink) => this.agentLoop.addApprovalSink(sink),
      resolveApproval: (id, approved) => this.agentLoop.resolveConfirmation(id, approved),
      addQuestionSink: (sink) => this.questions.addSink(sink),
      answerQuestion: (id, text) => this.questions.answer(id, text),
      getPendingApproval: () => this.agentLoop.pendingApproval(),
      getActiveConversationId: () => this.sidebar.activeConversationId,
      getOpenConversations: () => this.sidebar.conversations,
      getArchivedConversations: () => this.sidebar.history,
      getRequestChains: () => this.requestChains.status(),
      getStreamingConversationIds: () => this.agentLoop.getStreamingIds(),
      clankerMode: () => this.agentLoop.getClankerMode(),
      // Not persisted here: a remote toggle must not silently outlive the window
      // it was set from. The sidebar toggle keeps its own workspaceState memory.
      setClankerMode: (on) => this.agentLoop.setClankerMode(on),
      contextBudget: (conversationId) => this.contextBudgetOf(conversationId),
      onCompactionEvent: (listener) => this.slashHandler.onCompactionEvent(listener),
      onUserNotification: (sink) => this.notifications.addSink(sink),
      onAgentProgress: (listener) => this.agentLoop.onAgentProgress(listener),
      compact: (conversationId, options) =>
        this.slashHandler.compactConversation(conversationId, {
          auto: false,
          ...(options?.trigger ? { trigger: options.trigger } : {}),
          ...(options?.remoteOrigin ? { remoteOrigin: options.remoteOrigin } : {}),
        }),
      setConversationModel: (conversationId, modelName) =>
        this.tabs.setModelById(conversationId, modelName),
      unloadModels: () => this.unloadModels(),
      restartModel: (modelName) => this.restartModel(modelName),
    });
    // Register the conversation lookup so the session timer can resolve ids,
    // then fold any unfinished intervals from a previous session into the
    // persisted totals.
    this.agentLoop.setConversationLookup((id) => this.getConversation(id));
    this.agentLoop.restoreSessionTimers(this.sidebar);
    this.persistSession();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    webviewView.webview.html = buildWebviewHtml(this.extensionUri, webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      this.handleMessage(raw as WebviewToHost);
    });
    webviewView.onDidChangeVisibility(() => this.residency.sync(this.view?.visible ?? false));
    webviewView.onDidDispose(() => this.residency.stop());
    this.residency.sync(this.view?.visible ?? false);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Opens the active turn's changes in VS Code's native diff editor. */
  async reviewCheckpoint(): Promise<void> {
    await this.review.open(this.checkpoints.pendingSnapshots(this.sidebar.activeConversationId));
  }

  async undo(): Promise<string[]> {
    const convId = this.sidebar.activeConversationId;
    const restored = await this.checkpoints.undo(convId);
    this.codeLens.clearPending();
    this.post({ type: 'checkpointDismissed', conversationId: convId });
    return restored;
  }

  async keep(): Promise<void> {
    const convId = this.sidebar.activeConversationId;
    await this.checkpoints.keep(convId);
    this.codeLens.clearPending();
    this.post({ type: 'checkpointDismissed', conversationId: convId });
  }

  canUndo(): boolean {
    return this.checkpoints.canUndo(this.sidebar.activeConversationId);
  }

  async newConversation(): Promise<void> {
    this.tabs.create();
  }

  /** Stable addressed seam for the extension-scoped remote runtime. */
  getHostFacade(): ForgeHostFacade {
    return this.hostFacade;
  }

  /** @deprecated Use newConversation — kept for command registration compatibility. */
  newChat(): void {
    void this.newConversation();
  }

  clearChat(): void {
    this.tabs.clearActive();
  }

  /** Change the active conversation's model and finish any old-backend release. */
  async switchModel(name: string | null): Promise<void> {
    await this.tabs.pinModel(name);
  }

  submitPrompt(text: string, attachments?: AttachmentData[]): Promise<void> {
    return this.send.submitExternal(text, attachments);
  }

  async unloadModels(): Promise<void> {
    await this.pool.stopAll();
    this.events.onBackendStopped?.(this.config.active_model);
    this.post({
      type: 'backendDown',
      message: 'All models unloaded. Send a prompt to start the backend again.',
    });
  }

  /** Addressed lifecycle seam for owner-authenticated remote controls. */
  async restartModel(modelName: string): Promise<void> {
    await this.pool.release(modelName);
    await this.pool.acquire(modelName);
  }

  notifyBackendError(message: string): void {
    this.events.onBackendError?.(message);
    this.post({ type: 'backendDown', message });
  }

  prefillInput(text: string): void {
    void vscode.commands
      .executeCommand('workbench.view.extension.forge-sidebar')
      .then(() => this.post({ type: 'setInput', text }));
  }

  async runPromptToMarkdown(text: string): Promise<string> {
    return this.agentLoop.runPromptToMarkdown(text);
  }

  async reindexCodebase(): Promise<void> {
    await reindexCodebase(this.indexManager, (msg) => this.post(msg));
  }

  applyForgeConfig(next: ForgeConfig): void {
    this.config = next;
    this.agentLoop.clearCapabilityCache();
    this.pool.applyForgeConfig(next);
    this.indexManager.applyForgeConfig(next);
    this.postModels();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private postModels(): void {
    const active = this.sidebar.conversations.find(
      (conversation) => conversation.id === this.sidebar.activeConversationId,
    );
    // A conversation pin is the model SendPipeline will use. The picker must
    // show that same selection, including after a restored session.
    this.post(
      buildModelsMessage(this.config, this.pool, active?.active_model ?? this.config.active_model),
    );
  }

  private post(msg: HostToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  postWorkspaceInfo(): void {
    this.post(workspaceInfoMessage(this.workspaceRoot ?? ''));
  }

  private postSessionSync(): void {
    this.post(
      buildSessionSyncMessage(this.sidebar, this.agentLoop.getStreamingIds(), (conversation) =>
        this.agentLoop.getSessionActiveMs(conversation),
      ),
    );
  }

  private persistSession(): void {
    saveSidebarSession(this.workspaceState, this.sidebar);
  }

  /** Strip @profile + expand aliases to the base model name (F6). */
  private baseOf(id: string | null | undefined): string | null {
    if (!id) return null;
    return splitModelProfile(expandAlias(this.config, id)).base;
  }

  /** Recomputes and posts the budget for the ACTIVE conversation. */
  private postTokenBudget(): void {
    this.budget.publish(this.getActive());
  }

  private async autoCompact(
    conv: ConversationRuntime,
    chain: RequestChainContext,
  ): Promise<ContextThresholdAction | undefined> {
    return runAddressedAutoCompact(
      {
        post: (message) => this.post(message),
        requestChains: this.requestChains,
        compact: (conversationId) =>
          this.slashHandler.compactConversation(conversationId, { auto: true, trigger: 'auto' }),
        incompleteTurnReason: (conversationId) =>
          this.agentLoop.incompleteTurnReason(conversationId),
        resumeEnabled: () => this.config.auto_compact?.resume !== false,
      },
      conv,
      chain,
    );
  }

  private resumeAfterManualCompact(conversationId: string, reason: string): Promise<void> {
    const deps: CompactionPolicyDeps = {
      post: (msg) => this.post(msg),
      send: async (text, convId, options) => {
        await this.send.send(text, undefined, convId, options);
      },
    };
    return runManualCompactResume(deps, conversationId, reason);
  }

  private async interruptForSteering(conversationId: string): Promise<void> {
    this.requestChains.markCancelling(conversationId, 'interrupted');
    await this.agentLoop.interrupt(conversationId);
  }

  private getActive(): ConversationRuntime {
    return this.tabs.active();
  }

  /** Look up a conversation by id across open tabs and history. */
  /**
   * Per-slot context for any conversation, not just the active one — the
   * publisher renders the active tab only, but a remote chat can be bound to a
   * background conversation and still needs a truthful meter.
   */
  private contextBudgetOf(conversationId: string): { used: number; max: number } | undefined {
    const conv = this.getConversation(conversationId);
    if (!conv) return undefined;
    const model = this.resolveModelFor(conv.active_model ?? this.config.active_model);
    if (!model) return undefined;
    return {
      used: reportedContextTokens(conv),
      max: perSlotContext(model, this.config.llama_server),
    };
  }

  private resolveModelFor(selection: string | null | undefined): ModelConfig | undefined {
    const base = this.baseOf(selection);
    const raw = base ? this.config.models.find((entry) => entry.name === base) : undefined;
    // Group inheritance first: a model taking its ctx from a group (e.g.
    // `group: llamacpp-qwen3`) carries no num_ctx of its own, and the raw entry
    // reads 0 — which surfaced remotely as "no num_ctx for this model".
    return raw ? mergeGroupsIntoModel(this.config, raw) : undefined;
  }

  getConversation(id: string): ConversationRuntime | undefined {
    return (
      this.sidebar.conversations.find((c) => c.id === id) ??
      this.sidebar.history.find((c) => c.id === id)
    );
  }

  /** Total active agent time in ms for the currently active conversation. */
  getActiveSessionTimeMs(): number {
    const conv = this.getActive();
    return this.agentLoop.getSessionActiveMs(conv);
  }

  getActiveSessionMetrics(): SessionTimeSnapshot {
    const conv = this.getActive();
    return buildSessionMetrics(conv, this.agentLoop.getSessionActiveMs(conv));
  }

  /** Persist the current session to workspace state. */
  saveSession(): void {
    this.persistSession();
  }

  private handleMessage(msg: WebviewToHost): void {
    routeWebviewMessage(
      {
        post: (out) => this.post(out),
        postModels: () => this.postModels(),
        postSessionSync: () => this.postSessionSync(),
        postTokenBudget: () => this.postTokenBudget(),
        postWorkspaceInfo: () => this.postWorkspaceInfo(),
        isBackendReady: () => this.pool.isAnyReady(),
        getClankerMode: () => this.agentLoop.getClankerMode(),
        send: (text, attachments, conversationId) => {
          void this.send.send(text, attachments, conversationId);
        },
        steer: async (text, attachments, conversationId) => {
          // Steering ends only the request/turn. Unlike Stop, it deliberately
          // leaves the backend loaded so the redirected turn starts without a
          // llama-server model reload.
          await this.interruptForSteering(conversationId);
          await this.send.send(text, attachments, conversationId);
        },
        cancel: () => {
          this.requestChains.markCancelling(this.sidebar.activeConversationId);
          void this.agentLoop.cancel(this.sidebar.activeConversationId);
        },
        switchModel: (name) => this.tabs.pinModel(name),
        undo: () => this.undo(),
        keep: () => this.keep(),
        reviewCheckpoint: () => this.reviewCheckpoint(),
        newConversation: () => void this.newConversation(),
        switchConversation: (id) => this.tabs.switch(id),
        closeConversation: (id) => void this.tabs.close(id),
        restoreConversation: (id) => this.tabs.restore(id),
        deleteConversation: (id) => void this.tabs.deleteConversation(id),
        renameConversation: (id, title) => this.tabs.rename(id, title),
        runSlashCommand: (id) => void this.slashHandler.handle(id),
        openFile: (path, line, beside) => this.agentLoop.openFile(path, { line, beside }),
        resolveConfirmation: (id, approved) => this.agentLoop.resolveConfirmation(id, approved),
        recordWebviewDiagnostic: (message) => logWebviewDiagnostic(message),
      },
      msg,
    );
  }

  async dispose(): Promise<void> {
    this.residency.stop();
    this.budget.dispose();
    this.review.dispose();
    await this.agentLoop.dispose();
    await this.checkpoints.dispose();
  }
}
