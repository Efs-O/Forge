import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import {
  expandAlias,
  mergeGroupsIntoModel,
  resolveRequestModel,
  splitModelProfile,
} from '../config/ConfigResolver';
import { isLocalModel } from '../backend/ModelHeuristics';
import type { ForgeSlashCommandId, HostToWebview, WebviewToHost } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import {
  createDefaultSession,
  historyMetasFromSession,
  loadSidebarSession,
  MAX_CONVERSATIONS,
  saveSidebarSession,
  slimMessagesById,
  tabMetasFromSession,
} from './sessionTypes';
import type { AttachmentData } from './messageBridge';
import { computeContextBudget, estimateToolTokens, perSlotContext } from '../util/contextBudget';
import { CheckpointStack } from '../checkpoint/CheckpointStack';
import { ToolRegistry } from '../tools/ToolRegistry';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { DiffDecorations } from './DiffDecorations';
import { CheckpointReview } from './CheckpointReview';
import type { WorkerRunRequest, WorkerRunResult } from '../workers/types';
import { ToolFailureTracker } from '../tools/StripTools';
import { getLogger } from '../util/logger';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import { AgentLoop } from './AgentLoop';
import type { SidebarProviderEvents } from './AgentLoop';
import { SessionLogger } from './SessionLogger';
import { SlashCommandHandler } from './SlashCommandHandler';
import { applyCompactionWindow } from './compactionWindow';
import { autoCompactAndResume } from './CompactionService';
import {
  opNewConversation,
  opSwitchConversation,
  opCloseConversation,
  opRestoreConversation,
  opClearMessages,
  opSetActiveConversationModel,
} from './ConversationOps';
import { buildWebviewHtml } from './WebviewBuilder';
import type { IndexManager } from '../search/IndexManager';

export type { SidebarProviderEvents };

const log = getLogger();

/** Minimum gap between mid-turn context recomputations. */
const CONTEXT_TICK_THROTTLE_MS = 500;

function writeForgeBridge(model: string, usedTokens: number, maxTokens: number): void {
  try {
    const dir = path.join(os.homedir(), '.forge');
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      model,
      used_tokens: usedTokens,
      max_tokens: maxTokens,
      timestamp_ms: Date.now(),
    });
    fs.writeFileSync(path.join(dir, 'hallumeter-bridge.json'), payload, 'utf8');
  } catch {
    // non-fatal — HalluMeter will simply show stale/unavailable
  }
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'forge.sidebar';

  private view?: vscode.WebviewView;
  private sidebar: SidebarRuntime;
  private readonly failureTracker = new ToolFailureTracker();
  private readonly sessionLoggers = new Map<string, SessionLogger>();
  private readonly agentLoop: AgentLoop;
  private readonly slashHandler: SlashCommandHandler;
  private readonly review = new CheckpointReview();
  private contextWarningShown = false;
  /** Auto-compact resumes issued since the last user prompt. Bounded so a task
   *  that keeps filling the window cannot drive Forge in a loop. */
  private autoContinues = 0;
  private lastContextTickAt = 0;
  private contextTickTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingContextTickConvId: string | undefined;
  private readonly exactContextTokens = new Map<string, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pool: IBackendPool,
    private config: ForgeConfig,
    private readonly checkpoints: CheckpointStack,
    private readonly toolRegistry: ToolRegistry,
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
    const savedClanker = workspaceState.get<boolean>('forge.clankerMode', false);
    this.agentLoop = new AgentLoop(
      pool,
      () => this.config,
      toolRegistry,
      checkpoints,
      codeLens,
      diffDecorations,
      this.failureTracker,
      events,
      (msg) => this.post(msg),
      () => this.view,
      templateEngine,
      forgeLoader,
      secrets,
      workspaceRoot,
      getConfigPath,
      undefined,
      cliSessions,
    );
    if (savedClanker) this.agentLoop.setClankerMode(true);
    // Keeps the ctx bar and the HalluMeter bridge live during a turn instead of
    // frozen until it ends. Fired once per tool round, never per token.
    this.agentLoop.setContextChangedListener((convId, promptChanged) =>
      this.onTurnContextChanged(convId, promptChanged),
    );
    this.agentLoop.setExactContextTokensListener((convId, usedTokens) =>
      this.publishExactContextTokens(convId, usedTokens),
    );

    this.slashHandler = new SlashCommandHandler({
      getConfig: () => this.config,
      pool,
      events,
      reindexCodebase: () => this.reindexCodebase(),
      newConversation: () => this.newConversation(),
      clearMessages: () => this.clearActiveMessages(),
      submitPrompt: (text) => this.submitPrompt(text),
      undo: () => this.undo(),
      keep: () => this.keep(),
      post: (msg) => this.post(msg),
      getActiveConv: () => this.getActive(),
      persistSession: () => this.persistSession(),
      postSessionSync: () => this.postSessionSync(),
      invalidateExactTokenBudget: () => this.exactContextTokens.delete(this.getActive().id),
      postTokenBudget: () => this.postTokenBudget(),
      runPromptToMarkdown: (text) => this.agentLoop.runPromptToMarkdown(text),
      isStreaming: () => this.agentLoop.streaming,
      beginCompaction: (convId) => this.agentLoop.beginBackgroundWork(convId),
      toggleClanker: () => {
        const on = this.agentLoop.toggleClanker();
        void this.workspaceState.update('forge.clankerMode', on);
        return on;
      },
    });
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

  async dispatchWorkerRun(request: WorkerRunRequest): Promise<WorkerRunResult> {
    const conv = this.getActive();
    const selected = conv.active_model ?? this.config.active_model;
    if (!selected) throw new Error('Forge: no active coordinator model selected.');
    const model = resolveRequestModel(this.config, selected);
    const result = await this.agentLoop.runWorkerTurn(conv, model, request);
    this.persistSession();
    return result;
  }

  async newConversation(): Promise<void> {
    // Pin the current selection onto the new tab. Left unpinned it tracked the
    // global default, so switching to another tab and back silently re-pointed
    // this one at that tab's model.
    const result = opNewConversation(this.sidebar, this.config.active_model);
    if (result.atCap) {
      void vscode.window.showWarningMessage(
        `Forge: maximum ${MAX_CONVERSATIONS} conversations. Close one to add another.`,
      );
      return;
    }
    this.sidebar = result.sidebar;
    this.failureTracker.reset();
    this.persistSession();
    this.postModels();
    this.postSessionSync();
    this.postTokenBudget();
    log.debug('[SidebarProvider] new conversation tab');
  }

  /** @deprecated Use newConversation — kept for command registration compatibility. */
  newChat(): void {
    void this.newConversation();
  }

  clearChat(): void {
    this.clearActiveMessages();
  }

  async submitPrompt(text: string, attachments?: AttachmentData[]): Promise<void> {
    const activeId = this.sidebar.activeConversationId;
    if (
      this.agentLoop.isStreamingConv(activeId) &&
      !this.agentLoop.isCancellationPending(activeId)
    ) {
      throw new Error(
        'Forge: this conversation is still generating. Switch to it and cancel, or open a new tab.',
      );
    }
    await this.agentLoop.waitForCancelledTurns();
    if (this.agentLoop.isStreamingConv(activeId)) {
      throw new Error(
        'Forge: this conversation is still generating. Cancel it before sending again.',
      );
    }
    await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
    await this.handleSend(text, attachments);
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
    try {
      const summary = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Forge: rebuilding semantic code index...',
          cancellable: false,
        },
        async () => this.indexManager.reindex(),
      );
      const message = `Forge: semantic index rebuilt (${summary.filesIndexed} files, ${summary.chunksIndexed} chunks).`;
      this.post({ type: 'token', text: `\n> ${message}\n` });
      void vscode.window.showInformationMessage(message);
    } catch (err) {
      const message = `Forge: ${(err as Error).message}`;
      this.post({ type: 'error', message });
      void vscode.window.showErrorMessage(message);
    }
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
      models: this.config.models.map((m) => ({
        name: m.name,
        provider: m.provider ?? 'llama.cpp',
      })),
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
      tabs: tabMetasFromSession(this.sidebar, this.agentLoop.getStreamingIds()),
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

  /**
   * Recomputes and posts the context budget for the ACTIVE conversation.
   *
   * `evaluateThresholds` gates the 75% warning and auto-compact, and is set only
   * where a turn actually added context. Opening or switching a conversation
   * must refresh the numbers without acting on them — otherwise merely visiting
   * a full chat would compact it, and the refresh that follows a compaction
   * could immediately trigger another one.
   */
  private postTokenBudget(evaluateThresholds = false): void {
    this.computeAndPublishBudget(this.getActive(), evaluateThresholds);
  }

  /**
   * Mid-turn tick from AgentLoop, throttled leading+trailing.
   *
   * `computeAndPublishBudget` walks the model's compacted context window,
   * serializes every tool definition, and then writes the HalluMeter bridge with a synchronous
   * `writeFileSync`. A round of parallel tool calls can fire this several times
   * in a few milliseconds, and doing all of that on the extension host thread
   * each time would stall the UI it is meant to keep current.
   */
  private onTurnContextChanged(convId: string, promptChanged: boolean): void {
    // A tool result changed the prompt. Show the estimate until the next exact
    // llama-server count arrives for that newly prepared request.
    if (promptChanged) this.exactContextTokens.delete(convId);
    const elapsed = Date.now() - this.lastContextTickAt;
    if (elapsed >= CONTEXT_TICK_THROTTLE_MS) {
      this.lastContextTickAt = Date.now();
      this.publishBudgetFor(convId);
      return;
    }
    this.pendingContextTickConvId = convId;
    if (this.contextTickTimer) return;
    this.contextTickTimer = setTimeout(() => {
      this.contextTickTimer = undefined;
      this.lastContextTickAt = Date.now();
      const pending = this.pendingContextTickConvId;
      this.pendingContextTickConvId = undefined;
      if (pending) this.publishBudgetFor(pending);
    }, CONTEXT_TICK_THROTTLE_MS - elapsed);
  }

  private publishBudgetFor(convId: string): void {
    const conv = this.sidebar.conversations.find((c) => c.id === convId);
    // Mid-turn ticks never evaluate thresholds: /compact refuses to run while
    // streaming, and compacting the transcript the tool loop is iterating would
    // corrupt the turn. Auto-compact stays in handleSend's post-turn finally.
    if (conv) this.computeAndPublishBudget(conv, false);
  }

  private computeAndPublishBudget(conv: ConversationRuntime, evaluateThresholds: boolean): void {
    // The bar renders only the active conversation, and letting a background
    // turn write the bridge would point HalluMeter at a model the user is not
    // looking at. Switching tabs calls postTokenBudget(), so the number is
    // refreshed on arrival either way.
    if (conv.id !== this.sidebar.activeConversationId) return;
    // The model the user is actually talking to lives on the conversation; the
    // config-level active_model is only a fallback default. Reading the config
    // alone measured the budget for the wrong model whenever the two differed —
    // and wrote (or skipped) the HalluMeter bridge on that wrong model's ctx.
    // Same precedence as submitPrompt and runWorkerTurn.
    const activeSelection = conv.active_model ?? this.config.active_model;
    const activeBase = this.baseOf(activeSelection);
    const rawModel = this.config.models.find((m) => m.name === activeBase);
    // Resolve group inheritance before reading num_ctx: models that take their ctx
    // from a group (`group: llamacpp-qwen3`) have no num_ctx of their own, and
    // reading the raw entry yielded 0 — silently disabling the budget and the
    // HalluMeter bridge for every such model.
    const activeModel = rawModel ? mergeGroupsIntoModel(this.config, rawModel) : undefined;
    const allowed = resolveToolPermissions(this.config);
    // `max` is now the PER-SLOT window: --ctx-size is the total and --parallel
    // divides it, so every n_parallel > 1 model used to report several times
    // the context it actually had, here and on the HalluMeter bridge.
    const estimated = computeContextBudget({
      // The retained transcript is for sidebar scrollback and persistence;
      // account for exactly the compacted window that AgentLoop sends to the
      // model. This value also drives the HalluMeter bridge.
      messages: applyCompactionWindow(conv.messages, conv.compaction),
      toolTokens: estimateToolTokens(this.toolRegistry.definitions(allowed)),
      model: activeModel,
      server: this.config.llama_server,
    });
    const used = this.exactContextTokens.get(conv.id) ?? estimated.used;
    const { max } = estimated;
    this.post({ type: 'tokenBudget', used, max });
    if (activeSelection && max > 0) {
      // Write the BASE name, not the raw selection: an `@profile` suffix would
      // never match a curve id on HalluMeter's side and would churn its session id.
      writeForgeBridge(activeBase ?? activeSelection, used, max);
    } else if (activeSelection) {
      // Fail loudly: this previously skipped in silence, so a config change that
      // stranded num_ctx took the context warning and the bridge down with it.
      log.warn(
        `token budget unavailable for '${activeSelection}' — no num_ctx on the model or its group(s); context warning and HalluMeter bridge disabled`,
      );
    }
    if (!evaluateThresholds) return;
    // Opt-in automatic compaction. Only reached post-turn, so compact()'s
    // not-while-streaming guard is already satisfied. Compaction is
    // non-destructive — the transcript is kept, only the model's window shrinks.
    const auto = this.config.auto_compact;
    const autoAt = auto?.at ?? 0.85;
    if (auto?.enabled === true && max > 0 && used / max >= autoAt) {
      log.info(`[auto-compact] context at ${Math.round((used / max) * 100)}% — compacting`);
      void this.autoCompact(conv);
      return;
    }
    if (max > 0 && used / max >= 0.75 && !this.contextWarningShown) {
      this.contextWarningShown = true;
      void vscode.window
        .showWarningMessage(
          'Forge: context window is 75% full — run /compact to keep the agent coherent.',
          'Run /compact',
        )
        .then((choice) => {
          if (choice === 'Run /compact') {
            void this.slashHandler.handle('compact');
          }
        });
    }
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
      send: (text) => this.handleSend(text, undefined, conv.id),
    });
  }

  private publishExactContextTokens(convId: string, usedTokens: number): void {
    const conv = this.sidebar.conversations.find((candidate) => candidate.id === convId);
    if (!conv || conv.id !== this.sidebar.activeConversationId) return;
    const activeSelection = conv.active_model ?? this.config.active_model;
    const activeBase = this.baseOf(activeSelection);
    const rawModel = this.config.models.find((model) => model.name === activeBase);
    const activeModel = rawModel ? mergeGroupsIntoModel(this.config, rawModel) : undefined;
    const max = activeModel ? perSlotContext(activeModel, this.config.llama_server) : 0;
    this.exactContextTokens.set(convId, usedTokens);
    this.post({ type: 'tokenBudget', used: usedTokens, max });
    if (activeSelection && max > 0) {
      writeForgeBridge(activeBase ?? activeSelection, usedTokens, max);
    }
  }

  private getActive(): ConversationRuntime {
    let conv = this.sidebar.conversations.find((c) => c.id === this.sidebar.activeConversationId);
    if (!conv && this.sidebar.conversations.length > 0) {
      conv = this.sidebar.conversations[0];
      this.sidebar.activeConversationId = conv.id;
    }
    if (!conv) {
      this.sidebar = createDefaultSession();
      saveSidebarSession(this.workspaceState, this.sidebar);
      conv = this.sidebar.conversations[0];
    }
    return conv;
  }

  private clearActiveMessages(): void {
    if (this.agentLoop.streaming) return;
    const conv = this.getActive();
    opClearMessages(conv);
    this.exactContextTokens.delete(conv.id);
    this.failureTracker.reset();
    this.persistSession();
    this.postSessionSync();
    this.postTokenBudget();
  }

  private async handleSend(
    text: string,
    attachments?: AttachmentData[],
    conversationId?: string,
  ): Promise<void> {
    const conv = conversationId
      ? this.sidebar.conversations.find((candidate) => candidate.id === conversationId)
      : this.getActive();
    if (!conv) {
      this.post({ type: 'error', message: 'Forge: the queued conversation is no longer open.' });
      return;
    }
    if (this.agentLoop.isStreamingConv(conv.id) && !this.agentLoop.isCancellationPending(conv.id)) {
      this.post({
        type: 'error',
        message: 'Forge: this conversation is still generating. Cancel it first or open a new tab.',
      });
      return;
    }
    await this.agentLoop.waitForCancelledTurns();
    if (this.agentLoop.isStreamingConv(conv.id)) {
      this.post({
        type: 'error',
        message: 'Forge: this conversation is still generating. Cancel it before sending again.',
      });
      return;
    }
    const modelName = conv.active_model ?? this.config.active_model;
    if (!modelName) {
      const message = 'Forge: no active model selected. Pick a model before sending.';
      this.events.onBackendError?.(message);
      this.post({ type: 'error', message });
      return;
    }
    // Request-time resolution: active_model may carry @profile (F6). Flattens
    // defaults + base + profile into a legacy ModelConfig for the agent loop.
    let selectedModel;
    try {
      selectedModel = resolveRequestModel(this.config, modelName, (m) => log.info(m));
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
      return;
    }
    // Persist the full selection (incl. @profile) on the conversation so tab
    // switches restore the same profile, not just the base model (F6).
    conv.active_model = modelName;
    this.contextWarningShown = false;
    try {
      await this.agentLoop.runTurn(conv, selectedModel, text, attachments);
    } finally {
      this.failureTracker.reset();
      this.persistSession();
      this.postSessionSync();
      this.postTokenBudget(true);
      this.flushSessionLog(conv.id);
    }
  }

  private flushSessionLog(convId: string): void {
    const conv = this.sidebar.conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    if (!this.sessionLoggers.has(convId)) {
      this.sessionLoggers.set(
        convId,
        new SessionLogger(convId, conv.title, conv.active_model ?? ''),
      );
    }
    const logger = this.sessionLoggers.get(convId)!;
    logger.updateTitle(conv.title);
    logger.flush(conv.messages, conv.active_model ?? '');
  }

  private handleMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'webviewReady':
        this.postModels();
        this.postSessionSync();
        // Without this the bar reads 0 until the next turn completes, and the
        // context warning cannot fire on the first turn after a window reload.
        this.postTokenBudget();
        if (this.pool.isAnyReady()) this.post({ type: 'ready' });
        this.post({ type: 'clankerChanged', enabled: this.agentLoop.getClankerMode() });
        break;

      case 'send':
        // A prompt from the user ends the auto-resume chain: whatever happens
        // next is their call again, not a continuation Forge chose.
        this.autoContinues = 0;
        void this.handleSend(msg.text, msg.attachments, msg.conversationId);
        break;

      case 'cancel':
        this.agentLoop.cancel(this.sidebar.activeConversationId);
        break;

      case 'switchModel':
        this.config.active_model = msg.name;
        // A conversation keeps its own model selection so it can be restored
        // when changing tabs. Update that selection too; otherwise a failed
        // CLI model (for example a usage-limited Claude/Codex session) remains
        // pinned and is retried despite the picker showing another model.
        opSetActiveConversationModel(this.sidebar, msg.name);
        this.persistSession();
        this.postModels();
        this.postSessionSync();
        break;

      case 'undo':
        void this.undo()
          .then((restored) =>
            this.post({
              type: 'token',
              text: `\n\n> ↩ Undid last turn — restored ${restored.length} file(s).\n\n`,
            }),
          )
          .catch((err: Error) => this.post({ type: 'error', message: err.message }));
        break;

      case 'keep':
        void this.keep().catch((err: Error) => this.post({ type: 'error', message: err.message }));
        break;

      case 'reviewCheckpoint':
        void this.reviewCheckpoint().catch((err: Error) =>
          this.post({ type: 'error', message: err.message }),
        );
        break;

      case 'newChat':
      case 'newConversation':
        void this.newConversation();
        break;

      case 'switchConversation':
        void this.applySwitchConversation(msg.id);
        break;

      case 'closeConversation':
        void this.applyCloseConversation(msg.id);
        break;

      case 'restoreConversation':
        void this.applyRestoreConversation(msg.id);
        break;

      case 'runSlashCommand':
        void this.slashHandler.handle(msg.commandId as ForgeSlashCommandId);
        break;

      case 'openFile':
        void this.agentLoop
          .openFile(msg.path, { line: msg.line, beside: msg.beside })
          .catch((err: Error) =>
            this.post({ type: 'error', message: `Could not open ${msg.path}: ${err.message}` }),
          );
        break;

      case 'confirmResponse':
        this.agentLoop.resolveConfirmation(msg.id, msg.approved);
        break;
    }
  }

  private async applySwitchConversation(id: string): Promise<void> {
    const result = opSwitchConversation(this.sidebar, id);
    if (!result) return;
    this.sidebar = result.sidebar;
    if (result.activeModelOverride) this.config.active_model = result.activeModelOverride;
    this.failureTracker.reset();
    this.persistSession();
    this.postModels();
    this.postSessionSync();
    this.postTokenBudget();
    this.events.onConversationSwitched?.(this.config.active_model ?? null);
  }

  private async applyCloseConversation(id: string): Promise<void> {
    const conv = this.sidebar.conversations.find((c) => c.id === id);
    const modelName = conv?.active_model;

    await this.agentLoop.stopStreamingIfNeeded(id);
    await this.agentLoop.disposeConversation(id);
    await this.checkpoints.disposeConversation(id);
    const result = opCloseConversation(this.sidebar, id);
    if (!result) return;
    this.sidebar = result.sidebar;
    this.failureTracker.reset();
    // Closing a tab hands focus to another one, which is a change of active
    // conversation like any other: adopt its pinned model instead of leaving
    // the closed tab's selection in place.
    const nextActive = this.sidebar.conversations.find((c) => c.id === result.newActiveId);
    if (nextActive?.active_model) this.config.active_model = nextActive.active_model;
    this.persistSession();
    this.postModels();
    this.postSessionSync();
    this.postTokenBudget();

    if (modelName) {
      // Compare on the base model: two tabs on the same GGUF (different @profile)
      // share one loaded backend, so the prompt must key by base (F6).
      const base = this.baseOf(modelName) ?? modelName;
      const modelConfig = this.config.models.find((m) => m.name === base);
      const otherTabUsesModel = this.sidebar.conversations.some(
        (c) => this.baseOf(c.active_model) === base,
      );
      if (!otherTabUsesModel && isLocalModel(modelConfig)) {
        void vscode.window
          .showInformationMessage(
            `"${base}" is still loaded in VRAM. Unload it to free memory?`,
            'Unload Now',
          )
          .then((choice) => {
            if (choice !== 'Unload Now') return;
            void this.pool.release(base).then(() => {
              this.events.onBackendStopped?.(base);
              this.post({ type: 'backendDown', message: `${base} unloaded.` });
            });
          });
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.contextTickTimer) clearTimeout(this.contextTickTimer);
    this.contextTickTimer = undefined;
    this.pendingContextTickConvId = undefined;
    this.review.dispose();
    await this.agentLoop.dispose();
    await this.checkpoints.dispose();
  }

  private async applyRestoreConversation(id: string): Promise<void> {
    const result = opRestoreConversation(this.sidebar, id);
    if ('atCap' in result && result.atCap) {
      void vscode.window.showWarningMessage(
        'Forge: maximum open conversations. Close one tab before reopening history.',
      );
      return;
    }
    if ('notFound' in result) return;
    if ('ok' in result) {
      this.sidebar = result.sidebar;
      if (result.activeModelOverride) this.config.active_model = result.activeModelOverride;
      this.failureTracker.reset();
      this.persistSession();
      this.postModels();
      this.postSessionSync();
      this.postTokenBudget();
    }
  }
}

// Compatibility export; canonical implementation lives in util/WorkspacePaths.
export { resolveWorkspacePath as resolveToolPath } from '../util/WorkspacePaths';
