/*
 * The sidebar's VS Code surface: webview lifecycle, the public API extension.ts
 * calls, and the `post*`/`persist` helpers every collaborator borrows.
 *
 * Collaborators are built elsewhere — `wireSidebar` (turn, compaction, tabs,
 * send) and `createSidebarHostFacade` (the remote/extension seam). Keep it that
 * way: construction wiring added here is what pushed this file past 500 before.
 * What stays is deliberate: the helpers close over `sidebar`, `config`, `pool`,
 * `agentLoop`, `workspaceRoot` and `budget`, and the `handleMessage` actions
 * literal over eight fields — extracting either means threading a context
 * object purely to shed lines.
 */
import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import { expandAlias, splitModelProfile } from '../config/ConfigResolver';
import type { HostToWebview, WebviewToHost, AttachmentData } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import type { HistoryArchive } from './HistoryArchive';
import { loadSidebarSession, saveActiveConversationId, saveSidebarSession } from './sessionTypes';
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
import type { ChatAttachmentStore } from './ChatAttachmentStore';
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
import { workspaceInfoMessage } from './workspaceInfo';
import { buildWebviewHtml, webviewResourceRoots } from './WebviewBuilder';
import type { IndexManager } from '../search/IndexManager';
import type { SessionTimeSnapshot } from '../vscode/SessionTimeStatusBar';
import type { RequestChainLifecycle } from './RequestChainLifecycle';
import type { ForgeHostFacade } from './ForgeHostFacade';
import { createSidebarHostFacade } from './sidebarFacadeWiring';
import { statusRowProgress } from './turnMirrorWiring';
import { ResidencyPoller } from './ResidencyPoller';
import type { UserQuestionService } from './UserQuestionService';
import type { UserNotificationService } from './UserNotificationService';
import { randomUUID } from 'crypto';
import type { MidTurnInbox } from '../agent/MidTurnInbox';
import type { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import { HiddenChatAlerts } from './hiddenChatAlerts';

export type { SidebarProviderEvents };
/** Residency refresh while visible: cheap, but fast enough to avoid a stale dot. */
const RESIDENCY_POLL_MS = 1500;

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'forge.sidebar';

  private view: vscode.WebviewView | undefined;
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
  private readonly midTurnInbox: MidTurnInbox;
  /** The mid-turn tell composer; the remote queue registers as a source. */
  public readonly tellDrain: MidTurnTellDrain;
  private readonly hostFacade: ForgeHostFacade;
  private readonly hiddenChatAlerts: HiddenChatAlerts;
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
    notifications: UserNotificationService,
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
    // Absent in tests and in any host without globalStorage; prompts then send
    // exactly as before, minus the transcript thumbnails.
    private readonly attachmentStore?: ChatAttachmentStore,
    // Archived conversations live in a file, not workspaceState; absent (no
    // folder open, or tests), they stay in the memento as before.
    private readonly historyArchive?: HistoryArchive,
  ) {
    this.sidebar = loadSidebarSession(workspaceState, historyArchive);
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
        persistActiveId: () => this.persistActiveId(),
        baseOf: (id) => this.baseOf(id),
        reindexCodebase: () => this.reindexCodebase(),
        newConversation: () => this.newConversation(),
        clearMessages: () => this.tabs.clearActive(),
        submitPrompt: (text) => this.submitPrompt(text),
        undo: () => this.undo(),
        keep: () => this.keep(),
        rememberClankerMode: (on) => void this.workspaceState.update('forge.clankerMode', on),
        unloadModels: () => this.unloadModels(),
        unloadActiveModel: () => this.unloadConversationModel(),
        isConversationQueued: (id) => this.queuedConversationIds?.has(id),
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
        attachmentStore,
        questions,
        notifications,
      },
    );
    this.agentLoop = runtime.agentLoop;
    this.slashHandler = runtime.slashHandler;
    this.budget = runtime.budget;
    this.tabs = runtime.tabs;
    this.send = runtime.send;
    this.requestChains = runtime.requestChains;
    this.midTurnInbox = runtime.midTurnInbox;
    this.tellDrain = runtime.tellDrain;
    this.hiddenChatAlerts = new HiddenChatAlerts({
      events,
      addApprovalSink: (sink) => this.agentLoop.addApprovalSink(sink),
      addQuestionSink: (sink) => this.questions.addSink(sink),
      activeConversationId: () => this.sidebar.activeConversationId,
      view: () => this.view,
      switchConversation: (id) => this.tabs.switch(id),
    });
    this.hostFacade = createSidebarHostFacade({
      runtime,
      getSidebar: () => this.sidebar,
      pool,
      questions,
      notifications,
      workspaceState,
      interrupt: (conversationId) => this.interruptForSteering(conversationId),
      unloadModels: () => this.unloadModels(),
      restartModel: (modelName) => this.restartModel(modelName),
    });
    // wireSidebar registered the conversation lookup, so unfinished intervals
    // from a previous session can now fold into the persisted totals.
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
      localResourceRoots: webviewResourceRoots(this.extensionUri, this.attachmentStore?.rootPath),
    };
    webviewView.webview.html = buildWebviewHtml(this.extensionUri, webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      this.handleMessage(raw as WebviewToHost);
    });
    webviewView.onDidChangeVisibility(() => {
      this.residency.sync(this.view?.visible ?? false);
      this.hiddenChatAlerts.seen();
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
      this.residency.stop();
    });
    this.residency.sync(this.view?.visible ?? false);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setRemoteStatus(status: { transports: string[]; paired: boolean }): void {
    this.remoteStatus = { transports: [...status.transports], paired: status.paired };
    this.post({ type: 'remoteStatus', ...this.remoteStatus });
  }

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

  /** Unload only one chat's model (default: the active tab). Throws on refusal. */
  unloadConversationModel(conversationId?: string): Promise<{ model: string; wasLoaded: boolean }> {
    return this.tabs.unloadModelOf(conversationId ?? this.getActive().id);
  }

  /** Addressed lifecycle seam for owner-authenticated remote controls. */
  async restartModel(modelName: string): Promise<void> {
    await this.pool.release(modelName);
    await this.pool.acquire(modelName);
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
    this.post(
      buildModelsMessage(this.config, this.pool, active?.active_model ?? this.config.active_model),
    );
  }

  private remoteStatus: { transports: string[]; paired: boolean } = {
    transports: [],
    paired: false,
  };
  private queuedConversationIds?: Set<string>;

  private post(msg: HostToWebview): void {
    this.view?.webview.postMessage(msg);
    const row = statusRowProgress(msg, (id) => this.agentLoop.isStreamingConv(id));
    if (row) this.agentLoop.reportProgress(row);
  }

  postWorkspaceInfo(): void {
    const webview = this.view?.webview;
    this.post(
      workspaceInfoMessage(
        this.workspaceRoot ?? '',
        webview ? (uri) => webview.asWebviewUri(uri).toString() : undefined,
      ),
    );
  }

  private postSessionSync(): void {
    this.hiddenChatAlerts.seen();
    this.post(
      buildSessionSyncMessage(
        this.sidebar,
        this.agentLoop.getStreamingIds(),
        (conversation) => this.agentLoop.getSessionActiveMs(conversation),
        this.attachmentsRootUri(),
        new Set([
          ...this.agentLoop.pendingApprovalConversationIds(),
          ...this.questions.pendingConversationIds(),
        ]),
      ),
    );
  }

  private attachmentsRootUri(): string | undefined {
    if (!this.attachmentStore || !this.view) return undefined;
    return this.view.webview
      .asWebviewUri(vscode.Uri.file(this.attachmentStore.rootPath))
      .toString();
  }

  /**
   * Opens a stored attachment in VS Code's own viewer — the image preview for
   * images, the editor for text. `resolve` refuses a path that escapes the
   * store, so a crafted transcript row cannot address arbitrary files.
   */
  private async openAttachment(relativePath: string): Promise<void> {
    if (!this.attachmentStore) throw new Error('attachments are not stored in this window');
    const target = this.attachmentStore.resolve(relativePath);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
  }

  /** Every conversation id the session can still reach, open or archived. */
  liveConversationIds(): string[] {
    return [
      ...this.sidebar.conversations.map((conversation) => conversation.id),
      ...this.sidebar.history.map((conversation) => conversation.id),
    ];
  }

  private persistSession(): void {
    saveSidebarSession(this.workspaceState, this.sidebar, this.historyArchive);
  }

  /** Tab-switch persistence: one string, not the whole transcript blob. */
  private persistActiveId(): void {
    saveActiveConversationId(this.workspaceState, this.sidebar.activeConversationId);
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

  private async interruptForSteering(conversationId: string): Promise<void> {
    this.requestChains.markCancelling(conversationId, 'interrupted');
    await this.agentLoop.interrupt(conversationId);
  }

  private getActive(): ConversationRuntime {
    return this.tabs.active();
  }

  getActiveSessionMetrics(): SessionTimeSnapshot {
    const conv = this.getActive();
    return buildSessionMetrics(conv, this.agentLoop.getSessionActiveMs(conv));
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
        getRemoteStatus: () => this.remoteStatus,
        send: (text, attachments, conversationId) => {
          const targetId = conversationId ?? this.sidebar.activeConversationId;
          if (!attachments?.length && this.requestChains.isReserved(targetId)) {
            this.midTurnInbox.add(targetId, { id: randomUUID(), text });
            return;
          }
          void this.send.send(text, attachments, conversationId);
        },
        cancel: () => {
          this.requestChains.markCancelling(this.sidebar.activeConversationId);
          void this.agentLoop.cancel(this.sidebar.activeConversationId);
        },
        answerQuestion: (id, text) => {
          if (text === undefined) this.questions.dismiss(id);
          else this.questions.answer(id, text);
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
        openAttachment: (relativePath) => this.openAttachment(relativePath),
        resolveConfirmation: (id, approved) => this.agentLoop.resolveConfirmation(id, approved),
        recordWebviewDiagnostic: (message) => logWebviewDiagnostic(message),
        queuedConversationIds: (ids) => (this.queuedConversationIds = new Set(ids)),
      },
      msg,
    );
  }

  async dispose(): Promise<void> {
    this.hiddenChatAlerts.dispose();
    this.residency.stop();
    this.budget.dispose();
    this.review.dispose();
    await this.agentLoop.dispose();
    await this.checkpoints.dispose();
  }
}
