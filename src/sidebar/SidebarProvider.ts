import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import { expandAlias, mergeGroupsIntoModel, splitModelProfile } from '../config/ConfigResolver';
import type { HostToWebview, WebviewDiagnosticMsg, WebviewToHost } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import {
  historyMetasFromSession,
  loadSidebarSession,
  saveSidebarSession,
  slimMessagesById,
  tabMetasFromSession,
} from './sessionTypes';
import type { AttachmentData } from './messageBridge';
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
import { autoCompactAndResume, resumeAfterCompaction } from './CompactionService';
import { buildWebviewHtml } from './WebviewBuilder';
import type { IndexManager } from '../search/IndexManager';
import { modelPickerGroup } from './ModelPickerGroups';
import { reportedContextTokens } from '../util/contextBudget';
import type { SessionTimeSnapshot } from '../vscode/SessionTimeStatusBar';
import { getLogger } from '../util/logger';

const log = getLogger();

export type { SidebarProviderEvents };

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'forge.sidebar';

  private view?: vscode.WebviewView;
  private sidebar: SidebarRuntime;
  private readonly failureTracker = new ToolFailureTracker();
  private readonly agentLoop: AgentLoop;
  private readonly slashHandler: SlashCommandHandler;
  private readonly review = new CheckpointReview();
  /** Auto-compact resumes issued since the last user prompt. Bounded so a task
   *  that keeps filling the window cannot drive Forge in a loop. */
  private autoContinues = 0;
  private readonly budget: ContextBudgetPublisher;
  private readonly tabs: ConversationTabs;
  private readonly send: SendPipeline;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pool: IBackendPool,
    private config: ForgeConfig,
    private readonly checkpoints: CheckpointStack,
    toolRegistry: ToolRegistry,
    private readonly indexManager: IndexManager,
    private readonly workspaceState: vscode.Memento,
    private readonly codeLens: KeepUndoCodeLensProvider,
    diffDecorations: DiffDecorations,
    templateEngine?: TemplateEngine,
    private readonly events: SidebarProviderEvents = {},
    forgeLoader?: ForgeInstructionsLoader,
    secrets?: vscode.SecretStorage,
    workspaceRoot?: string,
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
        postTokenBudget: (evaluate) => this.postTokenBudget(evaluate),
        persistSession: () => this.persistSession(),
        baseOf: (id) => this.baseOf(id),
        autoCompact: (conv) => this.autoCompact(conv),
        resumeAfterManualCompact: (conversationId) => this.resumeAfterManualCompact(conversationId),
        reindexCodebase: () => this.reindexCodebase(),
        newConversation: () => this.newConversation(),
        clearMessages: () => this.tabs.clearActive(),
        submitPrompt: (text) => this.submitPrompt(text),
        undo: () => this.undo(),
        keep: () => this.keep(),
        rememberClankerMode: (on) => void this.workspaceState.update('forge.clankerMode', on),
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

  /**
   * Push the model list and the current selection to the picker.
   *
   * Must follow every change of active conversation: `sessionSync` carries no
   * model, and the webview's selection is only ever set from this message, so a
   * tab switch used to leave the header showing the previous tab's model while
   * the host had already switched to this tab's.
   */
  private postModels(): void {
    this.post({
      type: 'models',
      models: this.config.models.map((configured) => {
        const model = mergeGroupsIntoModel(this.config, configured);
        return {
          name: model.name,
          provider: model.provider ?? 'llama.cpp',
          group: modelPickerGroup(model),
        };
      }),
      active: this.config.active_model,
    });
  }

  private post(msg: HostToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private postSessionSync(): void {
    this.post({
      type: 'sessionSync',
      activeId: this.sidebar.activeConversationId,
      tabs: tabMetasFromSession(this.sidebar, this.agentLoop.getStreamingIds(), (conversation) =>
        this.agentLoop.getSessionActiveMs(conversation),
      ),
      history: historyMetasFromSession(this.sidebar),
      messagesById: slimMessagesById(this.sidebar),
    });
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
  private postTokenBudget(evaluateThresholds = false): void {
    this.budget.publish(this.getActive(), evaluateThresholds);
  }

  /** Threshold-triggered compaction. The resume policy lives in
   *  CompactionService; this only supplies the runtime it needs. */
  private async autoCompact(conv: ConversationRuntime): Promise<void> {
    await autoCompactAndResume({
      convId: conv.id,
      post: (msg) => this.post(msg),
      compact: (options) => this.slashHandler.compact(options),
      incompleteTurnReason: () => this.agentLoop.incompleteTurnReason(conv.id),
      resumeEnabled: this.config.auto_compact?.resume !== false,
      autoContinues: () => this.autoContinues,
      noteAutoContinue: () => {
        this.autoContinues += 1;
      },
      // Addressed to the conversation that was compacted, not to whatever tab
      // is active by the time the summary lands.
      send: (text) => this.send.send(text, undefined, conv.id),
    });
  }

  private async resumeAfterManualCompact(conversationId: string): Promise<void> {
    await resumeAfterCompaction(
      {
        convId: conversationId,
        post: (msg) => this.post(msg),
        incompleteTurnReason: () => this.agentLoop.incompleteTurnReason(conversationId),
        resumeEnabled: true,
        autoContinues: () => 0,
        noteAutoContinue: () => undefined,
        send: (text) => this.send.send(text, undefined, conversationId),
      },
      { automatic: false },
    );
  }
  private getActive(): ConversationRuntime {
    return this.tabs.active();
  }

  /** Look up a conversation by id across open tabs and history. */
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

  /**
   * Feeds the status bar. `contextTokens` is deliberately the same
   * `reportedContextTokens` value the sidebar bar and the HalluMeter bridge
   * render: it used to be `last_input_tokens` alone, so the two displays
   * disagreed by the size of the last completion.
   */
  getActiveSessionMetrics(): SessionTimeSnapshot {
    const conv = this.getActive();
    return {
      activeMs: this.agentLoop.getSessionActiveMs(conv),
      contextTokens: reportedContextTokens(conv),
      ...(conv.input_tokens !== undefined ? { inputTokens: conv.input_tokens } : {}),
      ...(conv.output_tokens !== undefined ? { outputTokens: conv.output_tokens } : {}),
      ...(conv.last_input_tokens !== undefined
        ? { currentInputTokens: conv.last_input_tokens }
        : {}),
      ...(conv.last_output_tokens !== undefined
        ? { currentOutputTokens: conv.last_output_tokens }
        : {}),
      ...(conv.model_request_count !== undefined ? { requestCount: conv.model_request_count } : {}),
    };
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
        isBackendReady: () => this.pool.isAnyReady(),
        getClankerMode: () => this.agentLoop.getClankerMode(),
        send: (text, attachments, conversationId) => {
          // A prompt from the user ends the auto-resume chain: whatever happens
          // next is their call again, not a continuation Forge chose.
          this.autoContinues = 0;
          void this.send.send(text, attachments, conversationId);
        },
        steer: async (text, attachments, conversationId) => {
          // Steering ends only the request/turn. Unlike Stop, it deliberately
          // leaves the backend loaded so the redirected turn starts without a
          // llama-server model reload.
          this.autoContinues = 0;
          await this.agentLoop.interrupt(conversationId);
          await this.send.send(text, attachments, conversationId);
        },
        cancel: () => void this.agentLoop.cancel(this.sidebar.activeConversationId),
        switchModel: (name) => this.tabs.pinModel(name),
        undo: () => this.undo(),
        keep: () => this.keep(),
        reviewCheckpoint: () => this.reviewCheckpoint(),
        newConversation: () => void this.newConversation(),
        switchConversation: (id) => this.tabs.switch(id),
        closeConversation: (id) => void this.tabs.close(id),
        restoreConversation: (id) => this.tabs.restore(id),
        runSlashCommand: (id) => void this.slashHandler.handle(id),
        openFile: (path, line, beside) => this.agentLoop.openFile(path, { line, beside }),
        resolveConfirmation: (id, approved) => this.agentLoop.resolveConfirmation(id, approved),
        recordWebviewDiagnostic: (message) => this.recordWebviewDiagnostic(message),
      },
      msg,
    );
  }

  private recordWebviewDiagnostic(message: WebviewDiagnosticMsg): void {
    const prefix = `[webview:${message.instanceId}] ${message.kind}`;
    const summary = JSON.stringify(message.summary);
    if (
      message.kind === 'error' ||
      message.kind === 'unhandledrejection' ||
      message.kind === 'react-error'
    ) {
      log.error(`${prefix} message=${message.message ?? 'unknown'} summary=${summary}`);
      if (message.stack) log.error(`${prefix} stack=${message.stack}`);
      if (message.componentStack) log.error(`${prefix} component=${message.componentStack}`);
      if (message.recent) log.error(`${prefix} recent=${JSON.stringify(message.recent)}`);
      return;
    }
    log.info(`${prefix} summary=${summary}`);
  }

  async dispose(): Promise<void> {
    this.budget.dispose();
    this.review.dispose();
    await this.agentLoop.dispose();
    await this.checkpoints.dispose();
  }
}
