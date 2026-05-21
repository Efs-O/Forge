import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import { isLocalModel } from '../backend/ModelHeuristics';
import type { ForgeSlashCommandId, HostToWebview, WebviewToHost } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import {
  createDefaultSession,
  historyMetasFromSession,
  loadSidebarSession,
  MAX_CONVERSATIONS,
  saveSidebarSession,
  slimMessagesById,
  tabMetasFromSession,
} from './sessionTypes';
import type { ChatMessage } from '../llm/types';
import type { AttachmentData } from './messageBridge';
import { CheckpointStack } from '../checkpoint/CheckpointStack';
import { ToolRegistry, FORGE_PERMISSIONS } from '../tools/ToolRegistry';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { DiffDecorations } from './DiffDecorations';
import { ToolFailureTracker } from '../tools/StripTools';
import { getLogger } from '../util/logger';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import { AgentLoop } from './AgentLoop';
import type { SidebarProviderEvents } from './AgentLoop';
import { SessionLogger } from './SessionLogger';
import { SlashCommandHandler } from './SlashCommandHandler';
import {
  opNewConversation,
  opSwitchConversation,
  opCloseConversation,
  opRestoreConversation,
  opClearMessages,
} from './ConversationOps';
import { buildWebviewHtml } from './WebviewBuilder';
import { resolveToolPath } from './ToolDispatch';

export type { SidebarProviderEvents };

const log = getLogger();

function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    let chars = 0;
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += part.text.length;
      }
    } else if (m.content === null && m.tool_calls?.length) {
      chars += JSON.stringify(m.tool_calls).length;
    }
    if (m.reasoning) chars += m.reasoning.length;
    return sum + Math.ceil(chars / 4);
  }, 0);
}

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
  private contextWarningShown = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pool: IBackendPool,
    private config: ForgeConfig,
    private readonly checkpoints: CheckpointStack,
    private readonly toolRegistry: ToolRegistry,
    private readonly workspaceState: vscode.Memento,
    private readonly codeLens: KeepUndoCodeLensProvider,
    diffDecorations: DiffDecorations,
    templateEngine?: TemplateEngine,
    private readonly events: SidebarProviderEvents = {},
    forgeLoader?: ForgeInstructionsLoader,
  ) {
    this.sidebar = loadSidebarSession(workspaceState);
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
    );

    this.slashHandler = new SlashCommandHandler({
      getConfig: () => this.config,
      pool,
      events,
      newConversation: () => this.newConversation(),
      clearMessages: () => this.clearActiveMessages(),
      submitPrompt: (text) => this.submitPrompt(text),
      undo: () => this.undo(),
      keep: () => this.keep(),
      post: (msg) => this.post(msg),
      getActiveConv: () => this.getActive(),
      persistSession: () => this.persistSession(),
      postSessionSync: () => this.postSessionSync(),
      postTokenBudget: () => this.postTokenBudget(),
      runPromptToMarkdown: (text) => this.agentLoop.runPromptToMarkdown(text),
      isStreaming: () => this.agentLoop.streaming,
      toggleClanker: () => this.agentLoop.toggleClanker(),
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

  undo(): string[] {
    const restored = this.checkpoints.undo();
    this.codeLens.clearPending();
    this.post({ type: 'checkpointDismissed' });
    return restored;
  }

  keep(): void {
    this.checkpoints.keep();
    this.codeLens.clearPending();
    this.post({ type: 'checkpointDismissed' });
  }

  canUndo(): boolean { return this.checkpoints.canUndo(); }

  async newConversation(): Promise<void> {
    const result = opNewConversation(this.sidebar);
    if (result.atCap) {
      void vscode.window.showWarningMessage(`Forge: maximum ${MAX_CONVERSATIONS} conversations. Close one to add another.`);
      return;
    }
    this.sidebar = result.sidebar;
    this.failureTracker.reset();
    this.persistSession();
    this.postSessionSync();
    log.debug('[SidebarProvider] new conversation tab');
  }

  /** @deprecated Use newConversation — kept for command registration compatibility. */
  newChat(): void { void this.newConversation(); }

  clearChat(): void { this.clearActiveMessages(); }

  async submitPrompt(text: string, attachments?: AttachmentData[]): Promise<void> {
    const activeId = this.sidebar.activeConversationId;
    if (this.agentLoop.isStreamingConv(activeId)) {
      throw new Error('Forge: this conversation is still generating. Switch to it and cancel, or open a new tab.');
    }
    await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
    await this.handleSend(text, attachments);
  }

  async unloadModels(): Promise<void> {
    await this.pool.stopAll();
    this.events.onBackendStopped?.(this.config.active_model);
    this.post({ type: 'backendDown', message: 'All models unloaded. Send a prompt to start the backend again.' });
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

  applyForgeConfig(next: ForgeConfig): void {
    this.config = next;
    this.agentLoop.clearCapabilityCache();
    this.pool.applyForgeConfig(next);
    this.post({ type: 'models', names: this.config.models.map((m) => m.name), active: this.config.active_model });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private post(msg: HostToWebview): void { this.view?.webview.postMessage(msg); }

  private postSessionSync(): void {
    this.post({
      type: 'sessionSync',
      activeId: this.sidebar.activeConversationId,
      tabs: tabMetasFromSession(this.sidebar, this.agentLoop.getStreamingIds()),
      history: historyMetasFromSession(this.sidebar),
      messagesById: slimMessagesById(this.sidebar),
    });
  }

  private persistSession(): void { saveSidebarSession(this.workspaceState, this.sidebar); }

  private postTokenBudget(): void {
    const activeModel = this.config.models.find((m) => m.name === this.config.active_model);
    const msgTokens = estimateTokens(this.activeMessages());
    const toolTokens = Math.ceil(JSON.stringify(this.toolRegistry.definitions(FORGE_PERMISSIONS)).length / 4);
    const SYSTEM_AND_TEMPLATE_OVERHEAD = 200;
    const used = msgTokens + toolTokens + SYSTEM_AND_TEMPLATE_OVERHEAD;
    const max = activeModel?.num_ctx ?? 0;
    this.post({ type: 'tokenBudget', used, max });
    if (this.config.active_model && max > 0) {
      writeForgeBridge(this.config.active_model, used, max);
    }
    if (max > 0 && used / max >= 0.75 && !this.contextWarningShown) {
      this.contextWarningShown = true;
      void vscode.window.showWarningMessage(
        'Forge: context window is 75% full — run /compact to keep the agent coherent.',
        'Run /compact',
      ).then((choice) => {
        if (choice === 'Run /compact') {
          void this.slashHandler.handle('compact');
        }
      });
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

  private activeMessages(): ChatMessage[] { return this.getActive().messages; }

  private clearActiveMessages(): void {
    if (this.agentLoop.streaming) return;
    opClearMessages(this.getActive());
    this.failureTracker.reset();
    this.persistSession();
    this.postSessionSync();
  }

  private async handleSend(text: string, attachments?: AttachmentData[]): Promise<void> {
    if (!this.config.active_model) {
      const message = 'Forge: no active model selected. Pick a model before sending.';
      this.events.onBackendError?.(message);
      this.post({ type: 'error', message });
      return;
    }
    const selectedModel = this.config.models.find((m) => m.name === this.config.active_model);
    if (!selectedModel) {
      this.post({ type: 'error', message: `Model "${this.config.active_model}" not found in config.` });
      return;
    }
    const conv = this.getActive();
    this.contextWarningShown = false;
    try {
      await this.agentLoop.runTurn(conv, selectedModel, text, attachments);
    } finally {
      this.failureTracker.reset();
      this.persistSession();
      this.postSessionSync();
      this.postTokenBudget();
      this.flushSessionLog(conv.id);
    }
  }

  private flushSessionLog(convId: string): void {
    const conv = this.sidebar.conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    if (!this.sessionLoggers.has(convId)) {
      this.sessionLoggers.set(convId, new SessionLogger(convId, conv.title, this.config.active_model ?? ''));
    }
    const logger = this.sessionLoggers.get(convId)!;
    logger.updateTitle(conv.title);
    logger.flush(conv.messages, this.config.active_model ?? '');
  }

  private handleMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'webviewReady':
        this.post({ type: 'models', names: this.config.models.map((m) => m.name), active: this.config.active_model });
        this.postSessionSync();
        if (this.pool.isAnyReady()) this.post({ type: 'ready' });
        this.post({ type: 'clankerChanged', enabled: this.agentLoop.getClankerMode() });
        break;

      case 'send':
        void this.handleSend(msg.text, msg.attachments);
        break;

      case 'cancel':
        this.agentLoop.cancel(this.sidebar.activeConversationId);
        break;

      case 'switchModel':
        this.config.active_model = msg.name;
        this.post({ type: 'models', names: this.config.models.map((m) => m.name), active: this.config.active_model });
        break;

      case 'undo':
        try {
          const restored = this.undo();
          this.post({ type: 'token', text: `\n\n> ↩ Undid last turn — restored ${restored.length} file(s).\n\n` });
        } catch (err) { this.post({ type: 'error', message: (err as Error).message }); }
        break;

      case 'keep':
        try { this.keep(); }
        catch (err) { this.post({ type: 'error', message: (err as Error).message }); }
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
        void this.agentLoop.openFile(msg.path);
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
    this.postSessionSync();
    this.events.onConversationSwitched?.(this.config.active_model ?? null);
  }

  private async applyCloseConversation(id: string): Promise<void> {
    const conv = this.sidebar.conversations.find((c) => c.id === id);
    const modelName = conv?.active_model;

    await this.agentLoop.stopStreamingIfNeeded(id);
    const result = opCloseConversation(this.sidebar, id);
    if (!result) return;
    this.sidebar = result.sidebar;
    this.failureTracker.reset();
    this.persistSession();
    this.postSessionSync();

    if (modelName) {
      const modelConfig = this.config.models.find((m) => m.name === modelName);
      const otherTabUsesModel = this.sidebar.conversations.some((c) => c.active_model === modelName);
      if (!otherTabUsesModel && isLocalModel(modelConfig)) {
        void vscode.window.showInformationMessage(
          `"${modelName}" is still loaded in VRAM. Unload it to free memory?`,
          'Unload Now',
        ).then((choice) => {
          if (choice !== 'Unload Now') return;
          void this.pool.release(modelName).then(() => {
            this.events.onBackendStopped?.(modelName);
            this.post({ type: 'backendDown', message: `${modelName} unloaded.` });
          });
        });
      }
    }
  }


  private async applyRestoreConversation(id: string): Promise<void> {
    await this.agentLoop.stopStreamingIfNeeded(this.sidebar.activeConversationId);
    const result = opRestoreConversation(this.sidebar, id);
    if ('atCap' in result && result.atCap) {
      void vscode.window.showWarningMessage('Forge: maximum open conversations. Close one tab before reopening history.');
      return;
    }
    if ('notFound' in result) return;
    if ('ok' in result) {
      this.sidebar = result.sidebar;
      if (result.activeModelOverride) this.config.active_model = result.activeModelOverride;
      this.failureTracker.reset();
      this.persistSession();
      this.postSessionSync();
    }
  }
}

// Re-export resolveToolPath for consumers that previously imported from here
export { resolveToolPath };
