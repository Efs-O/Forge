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
import type { AgentLoop, SidebarProviderEvents } from './AgentLoop';
import type { PromptRunOptions } from './PromptRun';
import type { SlashCommandHandler } from './SlashCommandHandler';
import type { ChatAttachmentStore } from './ChatAttachmentStore';
import { wireSidebar } from './sidebarWiring';
import { reindexCodebase } from './reindexCommand';
import type { ContextBudgetPublisher } from './ContextBudgetPublisher';
import type { ConversationTabs } from './ConversationTabs';
import type { SendPipeline } from './SendPipeline';
import { routeWebviewMessage } from './webviewMessageRouter';
import { createProviderWebviewActions } from './providerWebviewActions';
import { JobsPanelBridge } from './jobPanelUpdates';
import { SessionContentSearch } from './sessionContentSearch';
import type { JobStore } from '../jobs/JobStore';
import {
  modelsMessageFor,
  followedSessionMetricsFor,
  buildSessionSyncMessage,
} from './sidebarPayloads';
import { workspaceInfoMessageForView } from './workspaceInfo';
import { readHistoryPanelSize } from './historyPanelSizeStore';
import { buildWebviewHtml, webviewResourceRoots } from './WebviewBuilder';
import type { IndexManager } from '../search/IndexManager';
import type { ForgeHostFacade } from './ForgeHostFacade';
import { createSidebarHostFacade } from './sidebarFacadeWiring';
import { agentLinkFacadeDeps } from './agentLinkFacadeDeps';
import { statusRowProgress } from './turnMirrorWiring';
import { ResidencyPoller } from './ResidencyPoller';
import type { UserQuestionService } from './UserQuestionService';
import type { UserNotificationService } from './UserNotificationService';
import { createSidebarAgentAsk } from './sidebarAgentAsk';
import type { StartAgentAsk } from '../agentLinks/pendingAgentAsks';
import type { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import { HiddenChatAlerts } from './hiddenChatAlerts';
import type { SidebarPromptRouter } from './backgroundExitNotice';
import { attachmentsRootUri } from './attachmentAccess';
import { listMemoryKeys } from '../tools/memoryTools';
import { retainSessionMemoryKeys } from './memorySnapshotLifecycle';
import { WebviewQueueState } from './evictionGate';
import { watchActivityViewConfiguration } from './activityViewSetting';
import { liveConversationIds } from './liveConversationIds';
import { legacyGlobalHistoryIds } from './legacyGlobalHistory';

export type { SidebarProviderEvents };
const RESIDENCY_POLL_MS = 1500;
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'forge.sidebar';

  private view: vscode.WebviewView | undefined;
  private sidebar: SidebarRuntime;
  private readonly failureTracker = new ToolFailureTracker();
  private readonly agentLoop: AgentLoop;
  private readonly slashHandler: SlashCommandHandler;
  private readonly review = new CheckpointReview();
  private readonly budget: ContextBudgetPublisher;
  private readonly tabs: ConversationTabs;
  private readonly send: SendPipeline;
  public readonly tellDrain: MidTurnTellDrain;
  private readonly promptRouter: SidebarPromptRouter;
  private readonly hostFacade: ForgeHostFacade;
  private readonly hiddenChatAlerts: HiddenChatAlerts;
  private readonly agentAsker: ReturnType<typeof createSidebarAgentAsk>;
  private readonly jobsBridge: JobsPanelBridge | undefined;
  private readonly sessionSearch: SessionContentSearch;
  remoteEvictionQuery: ((conversationId: string) => boolean | undefined) | undefined;
  remoteOriginQuery: ((conversationId: string) => string | undefined) | undefined;
  private readonly residency = new ResidencyPoller(
    () => this.pool.residencySignature(),
    () => this.postModels(),
    RESIDENCY_POLL_MS,
    () => this.pool.refreshExternalResidency(),
  );

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pool: IBackendPool,
    private config: ForgeConfig,
    private readonly checkpoints: CheckpointStack,
    toolRegistry: ToolRegistry,
    private readonly indexManager: IndexManager,
    private readonly questions: UserQuestionService,
    notifications: UserNotificationService,
    private readonly workspaceState: vscode.Memento,
    private readonly codeLens: KeepUndoCodeLensProvider,
    diffDecorations: DiffDecorations,
    templateEngine?: TemplateEngine,
    private readonly events: SidebarProviderEvents = {},
    forgeLoader?: ForgeInstructionsLoader,
    secrets?: vscode.SecretStorage,
    private readonly workspaceRoot?: string,
    getConfigPath?: () => string,
    cliSessions?: CliSessionRegistry,
    private readonly attachmentStore?: ChatAttachmentStore,
    private readonly historyArchive?: HistoryArchive,
    private readonly jobsStore?: JobStore,
    /** The store the history panel's saved size lives in; see `HistoryPanelSize.ts`. */
    private readonly globalState?: vscode.Memento,
  ) {
    this.agentAsker = createSidebarAgentAsk({
      getConfig: () => this.config,
      getSidebar: () => this.sidebar,
      checkpoints: this.checkpoints,
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      persist: () => this.persistSession(),
      onPendingChanged: () => this.tabs.refreshRetention(),
      deliver: (text, id) => this.promptRouter.deliverChatMessage(text, id),
    });
    this.sidebar = loadSidebarSession(workspaceState, historyArchive);
    retainSessionMemoryKeys(this.sidebar, listMemoryKeys(workspaceState));
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
        persistSession: (changedId) => this.persistSession(changedId),
        persistSidebar: (next) => saveSidebarSession(workspaceState, next, historyArchive),
        persistActiveId: () => this.persistActiveId(),
        baseOf: (id) => this.baseOf(id),
        reindexCodebase: () => this.reindexCodebase(),
        newConversation: () => this.newConversation(),
        clearMessages: () => this.tabs.clearActive(),
        submitPrompt: (text) => this.submitPrompt(text),
        undo: () => this.undo(),
        keep: () => this.keep(),
        unloadModels: () => this.unloadModels(),
        unloadActiveModel: () => this.unloadConversationModel(),
        isConversationQueued: (id) => this.webviewQueue.isQueued(id),
        isConversationDrafted: (id) => this.webviewQueue.isDraftBearing(id),
        remoteEvictionBlocks: (id) =>
          this.remoteEvictionQuery ? this.remoteEvictionQuery(id) : false,
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
        ...(this.historyArchive ? { archivedSessions: this.historyArchive.overflow } : {}),
        questions,
        notifications,
      },
    );
    this.agentLoop = runtime.agentLoop;
    this.slashHandler = runtime.slashHandler;
    this.budget = runtime.budget;
    this.tabs = runtime.tabs;
    this.send = runtime.send;
    this.tellDrain = runtime.tellDrain;
    this.promptRouter = runtime.promptRouter;
    this.hiddenChatAlerts = new HiddenChatAlerts({
      events,
      addApprovalSink: (sink) => this.agentLoop.addApprovalSink(sink),
      addQuestionSink: (sink) => this.questions.addSink(sink),
      sidebar: () => this.sidebar,
      view: () => this.view,
      switchConversation: (id) => this.tabs.switch(id),
    });
    this.hostFacade = createSidebarHostFacade({
      runtime,
      getSidebar: () => this.sidebar,
      pool,
      questions,
      notifications,
      persistConversation: (conversationId) => void this.persistSession(conversationId),
      interrupt: (conversationId) => this.promptRouter.interruptForSteering(conversationId),
      unloadModels: () => this.unloadModels(),
      restartModel: (modelName) => this.restartModel(modelName),
      ...agentLinkFacadeDeps(
        this.workspaceRoot,
        () => this.persistSession(),
        () => this.postSessionSync(),
        (conversationId, message) => this.post({ type: 'notice', message, conversationId }),
      ),
      askAgent: (conversationId, request, signal, onSessionLinked, onAccepted) =>
        this.agentAsker.ask(conversationId, request, signal, onSessionLinked, onAccepted),
      cancelAgentAsk: (conversationId) => this.agentAsker.cancel(conversationId),
    });
    // The sessions panel's Jobs section: one bridge, pushing only while a panel
    // is open, reading the same store the scheduler and `manage_jobs` write.
    this.jobsBridge = this.jobsStore
      ? new JobsPanelBridge({
          store: this.jobsStore,
          getView: () => this.view,
          hostFacade: () => this.hostFacade,
        })
      : undefined;
    // The search box's other half: the host reads the transcripts the webview cannot.
    this.sessionSearch = new SessionContentSearch({
      getSidebar: () => this.sidebar,
      getView: () => this.view,
      originChannelOf: (id) => this.remoteOriginQuery?.(id),
      ...(this.historyArchive ? { overflow: this.historyArchive.overflow } : {}),
    });
    this.agentLoop.restoreSessionTimers(this.sidebar);
    this.persistSession();
  }

  startConversationRetention = (): void => this.tabs.startRetention();

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    this.webviewQueue.viewResolved();
    this.tabs.refreshRetention();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewResourceRoots(this.extensionUri, this.attachmentStore?.rootPath),
    };
    webviewView.webview.html = buildWebviewHtml(this.extensionUri, webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      this.handleMessage(raw as WebviewToHost);
    });
    watchActivityViewConfiguration(webviewView, (message) => this.post(message));
    webviewView.onDidChangeVisibility(() => {
      this.residency.sync(this.view?.visible ?? false);
      this.hiddenChatAlerts.seen();
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.webviewQueue.viewDisposed();
        this.tabs.refreshRetention();
        // The Jobs panel's view is gone: its store listener, watchers and pending publish go too.
        this.jobsBridge?.dispose();
      }
      this.residency.stop();
    });
    this.residency.sync(this.view?.visible ?? false);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  setRemoteStatus(status: { transports: string[]; paired: boolean }): void {
    this.remoteStatus = { transports: [...status.transports], paired: status.paired };
    this.tabs.refreshRetention();
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

  /** Route tool-authored chat messages through the same path as typed prompts. */
  deliverChatMessage: SidebarPromptRouter['deliverChatMessage'] = (text, id, steer) =>
    this.promptRouter.deliverChatMessage(text, id, steer);

  startAgentAsk: StartAgentAsk = (id, request) => this.agentAsker.start(id, request);

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
    await this.pool.stopAll(true);
    this.events.onBackendStopped?.(this.config.active_model);
    this.post({
      type: 'backendDown',
      message: 'All models unloaded. Send a prompt to start the backend again.',
    });
  }

  /** Unload only one chat's model (default: the active tab). Throws on refusal. */
  unloadConversationModel(
    conversationId?: string,
  ): Promise<{ model: string; wasLoaded: boolean; serverStopped?: boolean }> {
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

  async runPromptToMarkdown(text: string, options?: PromptRunOptions): Promise<string> {
    return this.agentLoop.runPromptToMarkdown(text, undefined, options);
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
    this.post(modelsMessageFor(this.sidebar, this.config, this.pool));
  }
  private remoteStatus: { transports: string[]; paired: boolean } = {
    transports: [],
    paired: false,
  };
  private readonly webviewQueue = new WebviewQueueState();
  private post(msg: HostToWebview): void {
    this.view?.webview.postMessage(msg);
    const row = statusRowProgress(msg, (id) => this.agentLoop.isStreamingConv(id));
    if (row) this.agentLoop.reportProgress(row);
  }

  postWorkspaceInfo(): void {
    const webview = this.view?.webview;
    this.post(workspaceInfoMessageForView(this.workspaceRoot ?? '', this.extensionUri, webview));
  }

  private postSessionSync(): void {
    this.hiddenChatAlerts.seen();
    this.post(
      buildSessionSyncMessage(
        this.sidebar,
        this.agentLoop.getStreamingIds(),
        (conversation) => this.agentLoop.getSessionActiveMs(conversation),
        attachmentsRootUri({ store: this.attachmentStore, view: () => this.view }),
        new Set([
          ...this.agentLoop.pendingApprovalConversationIds(),
          ...this.questions.pendingConversationIds(),
        ]),
        this.historyArchive?.overflow.list(),
        readHistoryPanelSize(this.globalState),
        (conversationId) => this.remoteOriginQuery?.(conversationId),
        legacyGlobalHistoryIds(this.globalState, this.sidebar, this.historyArchive),
      ),
    );
    this.tabs.refreshRetention();
  }

  /** Every conversation id the session can still reach, open or archived. */
  liveConversationIds(): string[] {
    return liveConversationIds(this.sidebar, this.historyArchive?.overflow.list() ?? []);
  }

  /** A forgotten workspace memory must also leave already-saved compaction snapshots. */
  forgetMemoryKey(_key: string): void {
    if (retainSessionMemoryKeys(this.sidebar, listMemoryKeys(this.workspaceState))) {
      this.persistSession();
      this.postSessionSync();
    }
  }

  private persistSession(changedId?: string): Promise<boolean> {
    return saveSidebarSession(this.workspaceState, this.sidebar, this.historyArchive, changedId);
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

  private postTokenBudget(): void {
    this.budget.publish(this.getActive());
  }

  private getActive = (): ConversationRuntime => this.tabs.active();

  getSessionMetrics(followedId: string | undefined) {
    return followedSessionMetricsFor(this.sidebar, this.getActive(), this.agentLoop, followedId);
  }

  private handleMessage(msg: WebviewToHost): void {
    routeWebviewMessage(
      createProviderWebviewActions({
        post: (out) => this.post(out),
        postModels: () => this.postModels(),
        postSessionSync: () => this.postSessionSync(),
        postTokenBudget: () => this.postTokenBudget(),
        postWorkspaceInfo: () => this.postWorkspaceInfo(),
        getView: () => this.view,
        activeConversationId: () => this.sidebar.activeConversationId,
        pool: this.pool,
        tabs: this.tabs,
        agentLoop: this.agentLoop,
        questions: this.questions,
        slashHandler: this.slashHandler,
        promptRouter: this.promptRouter,
        cancelAgentAsk: (id) => this.agentAsker.cancel(id),
        webviewQueue: this.webviewQueue,
        ...(this.attachmentStore ? { attachmentStore: this.attachmentStore } : {}),
        hostFacade: () => this.hostFacade,
        getRemoteStatus: () => this.remoteStatus,
        jobsBridge: () => this.jobsBridge,
        sessionSearch: () => this.sessionSearch,
        globalState: () => this.globalState,
        undo: () => this.undo(),
        keep: () => this.keep(),
        reviewCheckpoint: () => this.reviewCheckpoint(),
        newConversation: () => void this.newConversation(),
      }),
      msg,
    );
  }

  async dispose(): Promise<void> {
    // Whatever panel is open stops here: its store listener, its three watchers,
    // its pending publish and its transcript walk must not outlive the extension.
    this.jobsBridge?.dispose();
    this.sessionSearch.dispose();
    this.promptRouter.dispose();
    this.hiddenChatAlerts.dispose();
    this.residency.stop();
    this.tabs.disposeRetention();
    this.budget.dispose();
    this.review.dispose();
    await this.agentLoop.dispose();
    await this.checkpoints.dispose();
  }
}
