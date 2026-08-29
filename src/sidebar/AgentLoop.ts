import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import { isCloudProvider } from '../llm/CloudProviders';
import type { AttachmentData } from './messageBridge';
import { appendUserPrompt, applyUsage, type UserPromptOptions } from './transcriptMutations';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import { deriveStaticCapabilities } from '../config/ConfigResolver';
import { CheckpointStack } from '../checkpoint/CheckpointStack';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import { ToolFailureTracker } from '../tools/StripTools';
import { SessionTimer } from './SessionTimer';
import { wireSessionTimer } from './sessionTimerWiring';
import type { SidebarProviderEvents } from './providerEvents';
import { getLogger } from '../util/logger';
import { CapabilityCache } from './CapabilityCache';
import { ToolDispatch, type OpenFileOptions } from './ToolDispatch';
import { TurnLifecycle } from './TurnLifecycle';
import { runCliTurn } from './CliTurn';
import { runModelTurn } from './ModelTurn';
import type { TurnServices } from './turnServices';
import { makeRunModelTurn } from './turnServices';
import { runPromptToMarkdown, type PromptRunOptions } from './PromptRun';
import { runCloudProviderTurn, runLocalProviderTurn } from './ProviderTurn';
import type { ForgeTurnOutcome } from './turnOutcome';
import type { DiffDecorations } from './DiffDecorations';
import { ToolApprovalService } from './ToolApprovalService';
import type { ToolApprovalSink, ToolApprovalRequestEvent } from './ToolApprovalService';
import { recordModelUsage } from './modelManager/usageTracker';
import { CliAgentDriver } from '../agents/CliAgentDriver';
import {
  CliSessionRegistry,
  DEFAULT_CLI_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_CLI_AGENTS,
} from '../agents/CliSessionRegistry';
const log = getLogger();

export type { SidebarProviderEvents } from './providerEvents';

export class AgentLoop {
  /** Streaming/cancellation state for every conversation. */
  private readonly lifecycle = new TurnLifecycle();
  private readonly capabilities = new CapabilityCache();
  private readonly toolDispatch: ToolDispatch;
  private readonly approvals: ToolApprovalService;
  private readonly workspaceRoot: string;
  private readonly cliSessions: CliSessionRegistry;
  /** Collaborators handed to every turn module. Assembled once, in the ctor. */
  private readonly services: TurnServices;
  /** Every out-of-band prompt remains independently cancellable by owner. */
  private readonly promptRunControllers = new Map<AbortController, string | undefined>();
  private readonly sessionTimer = new SessionTimer();
  /**
   * Resolves a conversation id to its runtime object. Set by the SidebarProvider
   * after construction; without it the session timer is a no-op.
   */
  private conversationLookup: ((id: string) => ConversationRuntime | undefined) | null = null;
  private onContextChanged?: (convId: string) => void;
  private onTranscriptChanged?: (convId: string) => void;

  /**
   * Registers the mid-turn context listener. A setter rather than an 18th
   * constructor parameter. Fired once per round, when the server reports that
   * round's token usage, and once more when the turn ends — never per token,
   * because publishing writes the HalluMeter bridge synchronously.
   */
  setContextChangedListener(listener: (convId: string) => void): void {
    this.onContextChanged = listener;
  }

  /**
   * Registers a conversation lookup so the session timer can resolve
   * conversation ids to runtime objects. Set by SidebarProvider after
   * construction.
   */
  setConversationLookup(lookup: (id: string) => ConversationRuntime | undefined): void {
    this.conversationLookup = lookup;
  }

  /** Total active agent time in ms for a conversation (including in-progress). */
  getSessionActiveMs(conv: ConversationRuntime): number {
    return this.sessionTimer.totalActiveMs(conv);
  }

  /** Restore unfinished intervals after a VS Code reload. Call once at startup. */
  restoreSessionTimers(session: SidebarRuntime): void {
    this.sessionTimer.restoreUnfinishedIntervals(session);
  }

  /** Snapshots transcript mutations while a turn is still in progress. */
  setTranscriptChangedListener(listener: (convId: string) => void): void {
    this.onTranscriptChanged = listener;
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
    this.approvals.setApprovalLifecycle(
      (convId) => this.sessionTimer.pauseApproval(convId),
      (convId) => this.sessionTimer.resumeApproval(convId),
    );
    wireSessionTimer(events, {
      timer: this.sessionTimer,
      lookup: (id) => this.conversationLookup?.(id),
      onTranscriptChanged: (convId) => this.onTranscriptChanged?.(convId),
    });
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
    this.services = {
      pool,
      getConfig,
      toolRegistry,
      toolDispatch: this.toolDispatch,
      failureTracker,
      approvals: this.approvals,
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
      capabilities: (model, baseUrl) => this.capabilities.get(model, baseUrl),
      warnOnce: (key, message) => this.warnOnce(key, message),
      // Wrapped rather than passed: both listeners are registered after
      // construction, so a snapshot taken here would capture undefined.
      onContextChanged: (convId) => this.onContextChanged?.(convId),
      onUsage: (conv, inputTokens, outputTokens) => {
        applyUsage(conv, inputTokens, outputTokens);
        this.recordTranscriptMutation(conv);
      },
      onTranscriptChanged: (conv) => this.recordTranscriptMutation(conv),
      commitUserPrompt: (conv, text, attachments) => this.commitUserPrompt(conv, text, attachments),
      runModelTurn: makeRunModelTurn(() => this.services, runModelTurn),
      waitForCancelledTurns: () => this.waitForCancelledTurns(),
      setController: (ctrl, conversationId) => {
        this.promptRunControllers.set(ctrl, conversationId);
      },
      releaseController: (ctrl) => {
        this.promptRunControllers.delete(ctrl);
      },
    };
  }

  disposeConversation(id: string): Promise<void> {
    const conv = this.conversationLookup?.(id);
    if (conv) this.sessionTimer.disposeConversation(conv);
    return this.cliSessions.disposeConversation(id);
  }

  dispose(): Promise<void> {
    this.sessionTimer.dispose();
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
    this.abortPromptRuns(convId);
    return this.lifecycle.cancel(convId);
  }

  /** Interrupt a turn for steering without unloading its backend/model. */
  interrupt(convId: string): Promise<void> {
    this.approvals.cancelConversation(convId);
    this.abortPromptRuns(convId);
    return this.lifecycle.interrupt(convId);
  }

  private abortPromptRuns(conversationId?: string): void {
    for (const [ctrl, owner] of this.promptRunControllers) {
      if (conversationId === undefined || owner === conversationId) ctrl.abort();
    }
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

  addApprovalSink(sink: ToolApprovalSink): { dispose(): void } {
    return this.approvals.addSink(sink);
  }

  pendingApproval(): ToolApprovalRequestEvent | undefined {
    return this.approvals.pending();
  }

  clearCapabilityCache(): void {
    this.capabilities.clear();
  }

  async openFile(filePath: string, options?: OpenFileOptions): Promise<void> {
    return this.toolDispatch.openFile(filePath, options);
  }

  async runTurn(
    conv: ConversationRuntime,
    model: ModelConfig,
    text: string,
    attachments?: AttachmentData[],
    promptOptions?: UserPromptOptions,
  ): Promise<ForgeTurnOutcome> {
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
      return {
        kind: 'failed',
        error: `Forge: model "${model.name}" is not configured for image input.`,
        finalText: '',
      };
    }
    if (model.provider === 'cli') {
      return runCliTurn(this.services, conv, model, text, attachments, postC, promptOptions);
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

    const request = {
      conv,
      model,
      text,
      attachments,
      ...(promptOptions ? { promptOptions } : {}),
      activeFile,
      ctrl,
      postC,
    };
    if (isCloudProvider(model.provider)) {
      return runCloudProviderTurn(this.services, request);
    }
    return runLocalProviderTurn(this.services, request);
  }
  private commitUserPrompt(
    conv: ConversationRuntime,
    text: string,
    attachments?: AttachmentData[],
    options?: UserPromptOptions,
  ): void {
    appendUserPrompt(conv, text, attachments, options);
    this.recordTranscriptMutation(conv);
  }

  private recordTranscriptMutation(conv: ConversationRuntime): void {
    conv.updatedAt = Date.now();
    this.onTranscriptChanged?.(conv.id);
  }

  runPromptToMarkdown(
    text: string,
    conversationId?: string,
    options?: PromptRunOptions,
  ): Promise<string> {
    return runPromptToMarkdown(this.services, text, conversationId, options);
  }
  private warnOnce(key: string, message: string): void {
    this.capabilities.warnOnce(key, message, (text) => {
      void vscode.window.showWarningMessage(text);
    });
  }
}
