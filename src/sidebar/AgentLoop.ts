import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import { isCloudProvider } from '../llm/CloudProviders';
import type { AttachmentData } from './messageBridge';
import { buildUserContent } from './ConversationOps';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import { deriveStaticCapabilities } from '../config/ConfigResolver';
import { CheckpointStack } from '../checkpoint/CheckpointStack';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import { ToolFailureTracker } from '../tools/StripTools';
import { getLogger } from '../util/logger';
import {
  inspectRuntimeModelCapabilities,
  type RuntimeModelCapabilities,
} from '../backend/ModelCapabilities';
import { ToolDispatch, type OpenFileOptions } from './ToolDispatch';
import { TurnLifecycle } from './TurnLifecycle';
import { runCliTurn } from './CliTurn';
import { runModelTurn } from './ModelTurn';
import type { TurnServices } from './turnServices';
import { runWorkerTurn } from './WorkerTurn';
import { runPromptToMarkdown } from './PromptRun';
import { runCloudProviderTurn, runLocalProviderTurn } from './ProviderTurn';
import type { DiffDecorations } from './DiffDecorations';
import { deriveTitle } from './sessionTypes';
import { ToolApprovalService } from './ToolApprovalService';
import { WorkerOrchestrationService } from '../workers/WorkerOrchestrationService';
import type { WorkerRunRequest, WorkerRunResult } from '../workers/types';
import { recordModelUsage } from './modelManager/usageTracker';
import { CliAgentDriver } from '../agents/CliAgentDriver';
import {
  CliSessionRegistry,
  DEFAULT_CLI_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_CLI_AGENTS,
} from '../agents/CliSessionRegistry';
const log = getLogger();

export interface SidebarProviderEvents {
  onGenerationStarted?: (modelName: string | null) => void;
  onGenerationFinished?: (modelName: string | null) => void;
  onBackendError?: (message: string) => void;
  onBackendReady?: (modelName: string | null) => void;
  onBackendStopped?: (modelName: string | null) => void;
  onConversationSwitched?: (modelName: string | null) => void;
}

export class AgentLoop {
  /** Streaming/cancellation state for every conversation. */
  private readonly lifecycle = new TurnLifecycle();
  private readonly capabilityCache = new Map<string, Promise<RuntimeModelCapabilities>>();
  private readonly capabilityWarningsShown = new Set<string>();
  private readonly toolDispatch: ToolDispatch;
  private readonly approvals: ToolApprovalService;
  private readonly workerService: WorkerOrchestrationService;
  private readonly workspaceRoot: string;
  private readonly cliSessions: CliSessionRegistry;
  /** Collaborators handed to every turn module. Assembled once, in the ctor. */
  private readonly services: TurnServices;
  private promptRunCtrl: AbortController | null = null;
  private onContextChanged?: (convId: string, promptChanged: boolean) => void;
  private onExactContextTokens?: (convId: string, usedTokens: number) => void;

  /**
   * Registers the mid-turn context-growth listener. A setter rather than an
   * 18th constructor parameter. Fired once per tool round (after the round's
   * messages have landed on the conversation) and once when the turn's final
   * response completes — never per token, because recomputing the budget walks
   * the whole transcript and serializes every tool definition.
   */
  setContextChangedListener(listener: (convId: string, promptChanged: boolean) => void): void {
    this.onContextChanged = listener;
  }

  /** Receives llama-server's execution-side prompt token count. */
  setExactContextTokensListener(listener: (convId: string, usedTokens: number) => void): void {
    this.onExactContextTokens = listener;
  }

  get streaming(): boolean {
    return this.lifecycle.streaming;
  }
  isStreamingConv(id: string): boolean {
    return this.lifecycle.isStreaming(id);
  }
  /** Why the last turn on this conversation stopped short, if it did. */
  incompleteTurnReason(id: string): string | undefined {
    return this.lifecycle.incompleteReason(id);
  }

  beginBackgroundWork(convId: string): () => void {
    return this.lifecycle.beginBackgroundWork(convId);
  }

  isCancellationPending(id: string): boolean {
    return this.lifecycle.isCancellationPending(id);
  }
  getStreamingIds(): ReadonlySet<string> {
    return this.lifecycle.streamingIds();
  }

  constructor(
    pool: IBackendPool,
    getConfig: () => ForgeConfig,
    toolRegistry: ToolRegistry,
    checkpoints: CheckpointStack,
    codeLens: KeepUndoCodeLensProvider,
    diffDecorations: DiffDecorations,
    failureTracker: ToolFailureTracker,
    events: SidebarProviderEvents,
    private readonly post: (msg: HostToWebview) => void,
    getView: () => vscode.WebviewView | undefined,
    templateEngine?: TemplateEngine,
    forgeLoader?: ForgeInstructionsLoader,
    secrets?: vscode.SecretStorage,
    workspaceRoot?: string,
    private readonly getConfigPath?: () => string,
    cliDriver?: CliAgentDriver,
    cliSessions?: CliSessionRegistry,
  ) {
    this.workspaceRoot = workspaceRoot ?? forgeLoader?.root ?? '';
    const config = getConfig();
    this.cliSessions =
      cliSessions ??
      new CliSessionRegistry(
        config.max_cli_agents ?? DEFAULT_MAX_CLI_AGENTS,
        config.cli_idle_timeout_ms ?? DEFAULT_CLI_IDLE_TIMEOUT_MS,
      );
    this.approvals = new ToolApprovalService(post, getView);
    this.toolDispatch = new ToolDispatch(
      toolRegistry,
      checkpoints,
      codeLens,
      failureTracker,
      post,
      (name, detail, isDangerous, convId, signal) =>
        this.approvals.request(name, detail, isDangerous, convId, signal),
      diffDecorations,
    );
    this.workerService = new WorkerOrchestrationService({
      getConfig,
      pool,
      registry: toolRegistry,
      workspaceRoot: this.workspaceRoot,
      ...(secrets ? { secrets } : {}),
      onActivity: (activity, conversationId) =>
        this.post({ type: 'workerStatus', ...activity, conversationId }),
    });
    this.services = {
      pool,
      getConfig,
      toolRegistry,
      toolDispatch: this.toolDispatch,
      failureTracker,
      approvals: this.approvals,
      workerService: this.workerService,
      checkpoints,
      lifecycle: this.lifecycle,
      events,
      post,
      workspaceRoot: this.workspaceRoot,
      cliSessions: this.cliSessions,
      ...(secrets ? { secrets } : {}),
      ...(templateEngine ? { templateEngine } : {}),
      ...(forgeLoader ? { forgeLoader } : {}),
      ...(cliDriver ? { cliDriver } : {}),
      ...(this.getConfigPath ? { getConfigPath: this.getConfigPath } : {}),
      capabilities: (model, baseUrl) => this.getRuntimeCapabilities(model, baseUrl),
      warnOnce: (key, message) => this.warnOnce(key, message),
      // Wrapped rather than passed: both listeners are registered after
      // construction, so a snapshot taken here would capture undefined.
      onContextChanged: (convId, promptChanged) => this.onContextChanged?.(convId, promptChanged),
      onExactContextTokens: (convId, used) => this.onExactContextTokens?.(convId, used),
      commitUserPrompt: (conv, text, attachments) => this.commitUserPrompt(conv, text, attachments),
      runModelTurn: (baseUrl, conv, model, activeFile, ctrl, postC, apiKey, checkpoint) =>
        runModelTurn(this.services, {
          baseUrl,
          conv,
          model,
          activeFile,
          ctrl,
          postC,
          ...(apiKey ? { apiKey } : {}),
          checkpoint,
        }),
      waitForCancelledTurns: () => this.waitForCancelledTurns(),
      setController: (ctrl) => {
        this.promptRunCtrl = ctrl;
      },
      releaseController: (ctrl) => {
        if (this.promptRunCtrl === ctrl) this.promptRunCtrl = null;
      },
    };
    this.toolDispatch.setWorkerRunner((request, context) =>
      this.workerService.run(request, context),
    );
  }

  disposeConversation(id: string): Promise<void> {
    return this.cliSessions.disposeConversation(id);
  }

  dispose(): Promise<void> {
    return this.cliSessions.dispose();
  }

  async stopStreamingIfNeeded(convId?: string): Promise<void> {
    return this.lifecycle.stopStreaming(convId);
  }

  cancel(convId?: string): Promise<void> {
    // Approvals and the standalone prompt run are AgentLoop's, not the
    // lifecycle's: a pending confirmation and a /compact summary are neither
    // of them a turn.
    this.approvals.cancelConversation(convId);
    if (!convId) this.promptRunCtrl?.abort();
    return this.lifecycle.cancel(convId);
  }

  /** Wait for cancelled turns to release their backend/delegation resources.
   * Active, non-cancelled conversations remain independent and do not block. */
  async waitForCancelledTurns(): Promise<void> {
    return this.lifecycle.waitForCancelledTurns();
  }

  toggleClanker(): boolean {
    return this.approvals.toggleClankerMode();
  }

  setClankerMode(on: boolean): void {
    this.approvals.setClankerMode(on);
  }

  getClankerMode(): boolean {
    return this.approvals.getClankerMode();
  }

  resolveConfirmation(id: string, approved: boolean): void {
    this.approvals.resolve(id, approved);
  }

  clearCapabilityCache(): void {
    this.capabilityCache.clear();
    this.capabilityWarningsShown.clear();
  }

  async openFile(filePath: string, options?: OpenFileOptions): Promise<void> {
    return this.toolDispatch.openFile(filePath, options);
  }

  runWorkerTurn(
    conv: ConversationRuntime,
    model: ModelConfig,
    request: WorkerRunRequest,
  ): Promise<WorkerRunResult> {
    return runWorkerTurn(this.services, conv, model, request);
  }

  async runTurn(
    conv: ConversationRuntime,
    model: ModelConfig,
    text: string,
    attachments?: AttachmentData[],
  ): Promise<void> {
    await this.waitForCancelledTurns();
    const convId = conv.id;
    // A new turn supersedes whatever the previous one ended as; auto-compact
    // resume reads this and must never act on a stale verdict.
    this.lifecycle.clearIncomplete(convId);
    const postC = (msg: HostToWebview): void =>
      this.post({ ...msg, conversationId: convId } as HostToWebview);
    const hasImage = attachments?.some((attachment) => attachment.mediaType.startsWith('image/'));
    if (hasImage && !deriveStaticCapabilities(model).includes('vision')) {
      postC({
        type: 'error',
        message:
          `Forge: model "${model.name}" is not configured for image input. ` +
          'Choose a vision-capable model. For llama.cpp, set mmproj_path to its compatible ' +
          'projector; for other providers, declare the vision capability only when supported.',
      });
      return;
    }
    if (model.provider === 'cli') {
      await runCliTurn(this.services, conv, model, text, attachments, postC);
      return;
    }
    const ctrl = new AbortController();
    this.lifecycle.register(convId, ctrl);
    // conv.active_model is set by the caller (SidebarProvider) to the full
    // selection id, incl. any @profile — don't clobber it with the base name (F6).
    conv.active_model ??= model.name;
    conv.updatedAt = Date.now();

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    log.debug(`[AgentLoop] runTurn model=${model.name} conv=${convId}`);
    // Usage tracking (F7/2.3): single choke point for every provider — fire
    // and forget, debounced, never throws into the request path.
    const configPath = this.getConfigPath?.();
    if (configPath) recordModelUsage(configPath, model.name);

    const request = { conv, model, text, attachments, activeFile, ctrl, postC };
    if (isCloudProvider(model.provider)) {
      await runCloudProviderTurn(this.services, request);
      return;
    }
    await runLocalProviderTurn(this.services, request);
  }
  private commitUserPrompt(
    conv: ConversationRuntime,
    text: string,
    attachments?: AttachmentData[],
  ): void {
    const priorUserCount = conv.messages.filter((m) => m.role === 'user').length;
    conv.messages.push({ role: 'user', content: buildUserContent(text, attachments) });
    conv.updatedAt = Date.now();
    if (priorUserCount === 0) conv.title = deriveTitle(text.split('\n')[0] ?? text);
  }

  runPromptToMarkdown(text: string): Promise<string> {
    return runPromptToMarkdown(this.services, text);
  }
  private async getRuntimeCapabilities(
    model: ModelConfig,
    baseUrl: string,
  ): Promise<RuntimeModelCapabilities> {
    const cached = this.capabilityCache.get(model.name);
    if (cached) return cached;
    const pending = inspectRuntimeModelCapabilities(baseUrl, model);
    this.capabilityCache.set(model.name, pending);
    return pending;
  }

  private warnOnce(key: string, message: string): void {
    if (this.capabilityWarningsShown.has(key)) return;
    this.capabilityWarningsShown.add(key);
    void vscode.window.showWarningMessage(message);
  }
}
