import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { BackendController } from '../backend/BackendController';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import { streamModelChatCompletion } from '../llm/ChatClient';
import { isCloudProvider } from '../llm/CloudProviders';
import { resolveCloudRequestTarget } from '../llm/CloudRequestResolver';
import type { ChatCompletionRequest } from '../llm/types';
import type { AttachmentData } from './messageBridge';
import { buildUserContent } from './ConversationOps';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import { mergeSampling } from '../llm/SamplingMerge';
import { deriveStaticCapabilities, resolveRequestModel } from '../config/ConfigResolver';
import { normalizeRequestForModel } from '../llm/RequestNormalizer';
import { stripThinkingFromFullText } from '../llm/ThinkingChannelStripper';
import { stripHtmlDocumentBoilerplateFromFullText } from '../llm/HtmlDocumentBoilerplateStripper';
import { CheckpointStack, type CheckpointSession } from '../checkpoint/CheckpointStack';
import { ToolRegistry } from '../tools/ToolRegistry';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import { ToolBudget } from '../tools/ToolBudget';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import { ToolFailureTracker } from '../tools/StripTools';
import { stripStructuredOutputFromFullText } from '../tools/StructuredOutputParser';
import { getLogger } from '../util/logger';
import {
  inspectRuntimeModelCapabilities,
  type RuntimeModelCapabilities,
} from '../backend/ModelCapabilities';
import { ToolDispatch } from './ToolDispatch';
import type { DiffDecorations } from './DiffDecorations';
import { deriveTitle } from './sessionTypes';
import { extractToolDetail } from './toolSummary';
import { ToolApprovalService } from './ToolApprovalService';
import { WorkerOrchestrationService } from '../workers/WorkerOrchestrationService';
import type { WorkerRunRequest, WorkerRunResult } from '../workers/types';
import {
  addWorkerDelegationInstructions,
  buildWorkerCatalog,
  buildWorkerReviewPrompt,
} from '../workers/WorkerPrompts';
import { runToolCallingLoop } from '../agent/ToolCallingLoop';
import { recordModelUsage } from './modelManager/usageTracker';
import { CliAgentDriver } from '../agents/CliAgentDriver';
import { prepareCliChatAgent, runCliChat, runWarmCliChat } from '../agents/CliChatRunner';
import { CliSessionRegistry } from '../agents/CliSessionRegistry';
const log = getLogger();
const MAX_TOOL_ROUNDS = 20;
const DEFAULT_MAX_CLI_AGENTS = 4;
const DEFAULT_CLI_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export interface SidebarProviderEvents {
  onGenerationStarted?: (modelName: string | null) => void;
  onGenerationFinished?: (modelName: string | null) => void;
  onBackendError?: (message: string) => void;
  onBackendReady?: (modelName: string | null) => void;
  onBackendStopped?: (modelName: string | null) => void;
  onConversationSwitched?: (modelName: string | null) => void;
}

export class AgentLoop {
  private readonly streamingConvIds = new Set<string>();
  private readonly activeBackends = new Map<string, BackendController>();
  private readonly cancelControllers = new Map<string, AbortController>();
  private readonly streamingSettledMap = new Map<string, Promise<void>>();
  private readonly resolveSettledMap = new Map<string, () => void>();
  private readonly capabilityCache = new Map<string, Promise<RuntimeModelCapabilities>>();
  private readonly capabilityWarningsShown = new Set<string>();
  private readonly toolDispatch: ToolDispatch;
  private readonly approvals: ToolApprovalService;
  private readonly workerService: WorkerOrchestrationService;
  private readonly workspaceRoot: string;
  private readonly cliSessions: CliSessionRegistry;
  private promptRunCtrl: AbortController | null = null;

  get streaming(): boolean {
    return this.streamingConvIds.size > 0;
  }
  isStreamingConv(id: string): boolean {
    return this.streamingConvIds.has(id);
  }
  getStreamingIds(): ReadonlySet<string> {
    return this.streamingConvIds;
  }

  constructor(
    private readonly pool: IBackendPool,
    private readonly getConfig: () => ForgeConfig,
    private readonly toolRegistry: ToolRegistry,
    private readonly checkpoints: CheckpointStack,
    codeLens: KeepUndoCodeLensProvider,
    diffDecorations: DiffDecorations,
    private readonly failureTracker: ToolFailureTracker,
    private readonly events: SidebarProviderEvents,
    private readonly post: (msg: HostToWebview) => void,
    getView: () => vscode.WebviewView | undefined,
    private readonly templateEngine?: TemplateEngine,
    private readonly forgeLoader?: ForgeInstructionsLoader,
    private readonly secrets?: vscode.SecretStorage,
    workspaceRoot?: string,
    private readonly getConfigPath?: () => string,
    private readonly cliDriver?: CliAgentDriver,
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
    if (convId) {
      const ctrl = this.cancelControllers.get(convId);
      if (!ctrl) return;
      ctrl.abort();
      try {
        await this.activeBackends.get(convId)?.stop();
      } catch {
        /* abort is authoritative */
      }
      await this.streamingSettledMap.get(convId);
    } else {
      for (const [id, ctrl] of this.cancelControllers) {
        ctrl.abort();
        try {
          await this.activeBackends.get(id)?.stop();
        } catch (err) {
          log.debug(`[AgentLoop] backend stop during cancel-all failed: ${(err as Error).message}`);
        }
      }
      await Promise.all([...this.streamingSettledMap.values()]);
    }
  }

  cancel(convId?: string): void {
    this.approvals.cancelConversation(convId);
    if (convId) {
      this.cancelControllers.get(convId)?.abort();
      void this.activeBackends.get(convId)?.stop();
    } else {
      this.promptRunCtrl?.abort();
      for (const ctrl of this.cancelControllers.values()) ctrl.abort();
      for (const backend of this.activeBackends.values()) void backend.stop();
    }
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

  async openFile(filePath: string): Promise<void> {
    return this.toolDispatch.openFile(filePath);
  }

  async runWorkerTurn(
    conv: ConversationRuntime,
    model: ModelConfig,
    request: WorkerRunRequest,
  ): Promise<WorkerRunResult> {
    const convId = conv.id;
    const ctrl = new AbortController();
    this.cancelControllers.set(convId, ctrl);
    const settled = new Promise<void>((resolve) => this.resolveSettledMap.set(convId, resolve));
    this.streamingSettledMap.set(convId, settled);
    this.streamingConvIds.add(convId);
    const checkpoint = this.checkpoints.beginTurn(`workers-${Date.now()}`);
    const postC = (message: HostToWebview): void =>
      this.post({ ...message, conversationId: convId } as HostToWebview);
    postC({ type: 'generationStarted' });
    try {
      const dispatchTool = this.toolRegistry.get('dispatch_workers');
      if (!dispatchTool) throw new Error('Forge: dispatch_workers is unavailable.');
      this.toolRegistry.assertAllowed(
        dispatchTool,
        resolveToolPermissions(this.getConfig()),
        request as unknown as Record<string, unknown>,
      );
      if (this.workerService.hasCloudTargets(request)) {
        const approved = await this.approvals.request(
          'dispatch_workers',
          'Cloud workers may send their tasks and workspace file contents to configured providers.',
          true,
          convId,
          ctrl.signal,
        );
        if (!approved) throw new Error('Cloud worker launch declined.');
      }
      postC({ type: 'toolActivity', toolName: 'dispatch_workers', detail: 'starting workers' });
      const result = await this.workerService.run(request, {
        checkpoint,
        conversationId: convId,
        abortSignal: ctrl.signal,
        toolDispatch: this.toolDispatch,
        coordinatorModel: model.name,
      });
      this.commitUserPrompt(conv, buildWorkerReviewPrompt(result, request.review_task));
      postC({
        type: 'workerStatus',
        runId: result.runId,
        stage: 'review-started',
        elapsedMs: 0,
      });
      await this.runCoordinatorReview(conv, model, ctrl, checkpoint, postC);
      return result;
    } catch (err) {
      postC({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      const depthBefore = this.checkpoints.depth();
      this.checkpoints.commitTurn(checkpoint);
      if (this.checkpoints.depth() > depthBefore) postC({ type: 'checkpointReady' });
      this.activeBackends.delete(convId);
      this.streamingConvIds.delete(convId);
      this.resolveStreamingLifecycle(convId);
    }
  }

  private async runCoordinatorReview(
    conv: ConversationRuntime,
    model: ModelConfig,
    ctrl: AbortController,
    checkpoint: CheckpointSession,
    postC: (msg: HostToWebview) => void,
  ): Promise<void> {
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (isCloudProvider(model.provider)) {
      const target = await resolveCloudRequestTarget(model, this.secrets);
      await this.runAgentLoop(
        target.baseUrl,
        conv,
        model,
        activeFile,
        ctrl,
        postC,
        target.apiKey,
        checkpoint,
      );
      return;
    }
    const backend = await this.pool.acquire(model.name);
    this.activeBackends.set(conv.id, backend);
    await this.runAgentLoop(
      backend.baseUrl(),
      conv,
      model,
      activeFile,
      ctrl,
      postC,
      undefined,
      checkpoint,
    );
  }

  async runTurn(
    conv: ConversationRuntime,
    model: ModelConfig,
    text: string,
    attachments?: AttachmentData[],
  ): Promise<void> {
    const convId = conv.id;
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
      await this.runCliTurn(conv, model, text, attachments, postC);
      return;
    }
    const ctrl = new AbortController();
    this.cancelControllers.set(convId, ctrl);
    const settled = new Promise<void>((resolve) => {
      this.resolveSettledMap.set(convId, resolve);
    });
    this.streamingSettledMap.set(convId, settled);
    // conv.active_model is set by the caller (SidebarProvider) to the full
    // selection id, incl. any @profile — don't clobber it with the base name (F6).
    conv.active_model ??= model.name;
    conv.updatedAt = Date.now();

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    log.debug(`[AgentLoop] runTurn model=${model.name} conv=${convId}`);
    // Usage tracking (F7/§2.3): single choke point for every provider — fire
    // and forget, debounced, never throws into the request path.
    const configPath = this.getConfigPath?.();
    if (configPath) recordModelUsage(configPath, model.name);

    // Cloud providers (xai, openrouter): no local backend — resolve token and call the API directly.
    if (isCloudProvider(model.provider)) {
      let apiKey: string;
      let cloudBaseUrl: string;
      try {
        ({ baseUrl: cloudBaseUrl, apiKey } = await resolveCloudRequestTarget(model, this.secrets));
        log.info(`[AgentLoop] ${model.provider} token resolved for model=${model.name}`);
      } catch (err) {
        const msg = (err as Error).message;
        log.error(`[AgentLoop] ${model.provider} setup failed: ${msg}`);
        postC({ type: 'error', message: msg });
        this.resolveStreamingLifecycle(convId);
        return;
      }
      this.commitUserPrompt(conv, text, attachments);
      this.events.onBackendReady?.(model.name);
      postC({ type: 'ready' });
      const turnId = `turn-${Date.now()}`;
      const checkpoint = this.checkpoints.beginTurn(turnId);
      this.streamingConvIds.add(convId);
      this.events.onGenerationStarted?.(model.name);
      try {
        await this.runAgentLoop(
          cloudBaseUrl,
          conv,
          model,
          activeFile,
          ctrl,
          postC,
          apiKey,
          checkpoint,
        );
      } catch (err) {
        log.error(`[AgentLoop] ${model.provider} agent loop error: ${(err as Error).message}`);
        postC({ type: 'error', message: (err as Error).message });
      } finally {
        this.streamingConvIds.delete(convId);
        conv.updatedAt = Date.now();
        const depthBefore = this.checkpoints.depth();
        this.checkpoints.commitTurn(checkpoint);
        if (this.checkpoints.depth() > depthBefore) postC({ type: 'checkpointReady' });
        this.events.onGenerationFinished?.(model.name);
        this.resolveStreamingLifecycle(convId);
      }
      return;
    }

    let backend: BackendController;
    try {
      postC({ type: 'backendStarting', message: 'Starting backend, please wait…' });
      backend = await this.pool.acquire(model.name);
      this.activeBackends.set(convId, backend);
      this.events.onBackendReady?.(model.name);
      if (ctrl.signal.aborted) {
        postC({ type: 'done', finishReason: 'cancelled' });
        this.resolveStreamingLifecycle(convId);
        return;
      }
      this.commitUserPrompt(conv, text, attachments);
      postC({ type: 'ready' });
    } catch (err) {
      const msg = ctrl.signal.aborted
        ? 'Backend start cancelled.'
        : `Backend failed to start: ${(err as Error).message}`;
      this.events.onBackendError?.(msg);
      postC({ type: 'backendDown', message: msg });
      this.resolveStreamingLifecycle(convId);
      return;
    }

    const turnId = `turn-${Date.now()}`;
    const checkpoint = this.checkpoints.beginTurn(turnId);
    this.streamingConvIds.add(convId);
    this.events.onGenerationStarted?.(model.name);
    try {
      await this.runAgentLoop(
        backend.baseUrl(),
        conv,
        model,
        activeFile,
        ctrl,
        postC,
        undefined,
        checkpoint,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[AgentLoop] ${model.provider} chat failed model=${model.name}: ${message}`);
      this.events.onBackendError?.(message);
      postC({ type: 'error', message });
    } finally {
      this.streamingConvIds.delete(convId);
      this.activeBackends.delete(convId);
      conv.updatedAt = Date.now();
      const depthBefore = this.checkpoints.depth();
      this.checkpoints.commitTurn(checkpoint);
      if (this.checkpoints.depth() > depthBefore) postC({ type: 'checkpointReady' });
      this.events.onGenerationFinished?.(model.name);
      this.resolveStreamingLifecycle(convId);
    }
  }

  private async runCliTurn(
    conv: ConversationRuntime,
    model: ModelConfig,
    text: string,
    attachments: AttachmentData[] | undefined,
    postC: (msg: HostToWebview) => void,
  ): Promise<void> {
    const convId = conv.id;
    let prepared;
    try {
      postC({ type: 'backendStarting', message: `Starting ${model.name}…` });
      prepared = await prepareCliChatAgent(model, this.workspaceRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.events.onBackendError?.(message);
      postC({ type: 'backendDown', message });
      return;
    }

    const ctrl = new AbortController();
    this.cancelControllers.set(convId, ctrl);
    this.streamingSettledMap.set(
      convId,
      new Promise<void>((resolve) => this.resolveSettledMap.set(convId, resolve)),
    );
    conv.active_model ??= model.name;
    conv.updatedAt = Date.now();
    const configPath = this.getConfigPath?.();
    if (configPath) recordModelUsage(configPath, model.name);

    this.commitUserPrompt(conv, text, attachments);
    const checkpoint = this.checkpoints.beginTurn(`cli-chat-${Date.now()}`);
    this.streamingConvIds.add(convId);
    this.events.onBackendReady?.(model.name);
    this.events.onGenerationStarted?.(model.name);
    postC({ type: 'ready' });
    postC({ type: 'generationStarted' });

    try {
      const sessionId = conv.cli_sessions?.[model.name];
      const common = {
        prepared,
        model,
        messages: conv.messages,
        workspaceRoot: this.workspaceRoot,
        checkpoint,
        signal: ctrl.signal,
        onText: (chunk: string) => postC({ type: 'token', text: chunk }),
        onStatus: (detail: string) =>
          postC({ type: 'toolActivity', toolName: prepared.cliName, detail }),
        ...(sessionId ? { sessionId } : {}),
      };
      const result = this.cliDriver
        ? await runCliChat({ ...common, driver: this.cliDriver })
        : await runWarmCliChat({
            ...common,
            registry: this.cliSessions,
            key: { conversationId: conv.id, modelName: model.name },
          });
      if (result.sessionId) {
        conv.cli_sessions = { ...conv.cli_sessions, [model.name]: result.sessionId };
      }
      if (result.assistantText) {
        conv.messages.push({ role: 'assistant', content: result.assistantText });
      }
      if (result.status !== 'completed' && result.status !== 'cancelled') {
        postC({ type: 'error', message: result.error ?? `${model.name} failed.` });
      }
      postC({
        type: 'done',
        finishReason: result.status === 'completed' ? 'stop' : result.status,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[AgentLoop] cli chat failed model=${model.name}: ${message}`);
      this.events.onBackendError?.(message);
      postC({ type: 'error', message });
      postC({ type: 'done', finishReason: 'error' });
    } finally {
      this.streamingConvIds.delete(convId);
      conv.updatedAt = Date.now();
      const depthBefore = this.checkpoints.depth();
      this.checkpoints.commitTurn(checkpoint);
      if (this.checkpoints.depth() > depthBefore) postC({ type: 'checkpointReady' });
      this.events.onGenerationFinished?.(model.name);
      this.resolveStreamingLifecycle(convId);
    }
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

  async runPromptToMarkdown(text: string): Promise<string> {
    const config = this.getConfig();
    if (!config.active_model) throw new Error('Forge: no active model selected.');
    // Request-time resolution (defaults + base + @profile, F6).
    const selectedModel = resolveRequestModel(config, config.active_model, (m) => log.info(m));

    const backend = await this.pool.acquire(selectedModel.name);
    if (!backend.isReady()) await backend.start();
    this.events.onBackendReady?.(backend.loadedModel());

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const tmplCtx: Record<string, string> = {};
    if (activeFile) tmplCtx['activeFile'] = activeFile;
    if (config.custom_instructions) tmplCtx['customInstructions'] = config.custom_instructions;
    if (this.forgeLoader?.root) tmplCtx['workspaceRoot'] = this.forgeLoader.root;
    if (this.forgeLoader?.instructions)
      tmplCtx['forgeInstructions'] = this.forgeLoader.instructions;

    const messages = injectSystemPrompt(
      [{ role: 'user', content: text }],
      this.templateEngine,
      tmplCtx,
      selectedModel.system_prompt,
      selectedModel.system_prompt_mode,
    );
    const base: ChatCompletionRequest = { model: selectedModel.name, messages, stream: true };
    const request = normalizeRequestForModel(
      mergeSampling(base, selectedModel, { allowPreserveThinking: false }),
      selectedModel,
    );

    this.events.onGenerationStarted?.(selectedModel.name);
    const ctrl = new AbortController();
    this.promptRunCtrl = ctrl;
    let content = '';
    try {
      await new Promise<void>((resolve, reject) => {
        streamModelChatCompletion(
          backend.baseUrl(),
          request,
          selectedModel,
          {
            onToken: (token) => {
              content += token;
            },
            onReasoning: () => {},
            onDone: () => resolve(),
            onError: reject,
            onToolCalls: () => {},
          },
          ctrl.signal,
        );
      });
      return this.sanitizeText(content, this.shouldStripThinking(selectedModel));
    } catch (err) {
      this.events.onBackendError?.((err as Error).message);
      throw err;
    } finally {
      if (this.promptRunCtrl === ctrl) this.promptRunCtrl = null;
      this.events.onGenerationFinished?.(backend.loadedModel());
    }
  }

  private resolveStreamingLifecycle(convId: string): void {
    this.resolveSettledMap.get(convId)?.();
    this.resolveSettledMap.delete(convId);
    this.streamingSettledMap.delete(convId);
    this.cancelControllers.delete(convId);
  }

  private async runAgentLoop(
    baseUrl: string,
    conv: ConversationRuntime,
    activeModel: ModelConfig,
    activeFile: string | undefined,
    ctrl: AbortController,
    postC: (msg: HostToWebview) => void,
    apiKey?: string,
    checkpoint?: CheckpointSession,
  ): Promise<void> {
    const config = this.getConfig();
    const allowed = resolveToolPermissions(config);
    // One budget per turn — activeModel is already resolveRequestModel()'d
    // (group tools/tool_call_limits merged) by the caller.
    const budget = new ToolBudget(activeModel);
    const useStrip = this.failureTracker.shouldStrip();
    const runtimeCaps = await this.getRuntimeCapabilities(activeModel, baseUrl);
    const canUseThinkingKwargs = this.canUseThinkingKwargs(activeModel, runtimeCaps);
    const stripThinkingChannels = this.shouldStripThinking(activeModel);
    if (useStrip) {
      void vscode.window.showWarningMessage(
        'Forge: tool calls disabled after repeated failures. Restart chat to re-enable.',
      );
    }

    if (
      !canUseThinkingKwargs &&
      (activeModel.think !== undefined || activeModel.sampling?.preserve_thinking !== undefined)
    ) {
      this.warnOnce(
        `${activeModel.name}:thinking`,
        `Forge: model "${activeModel.name}" does not appear to support thinking template toggles. Thinking kwargs will be omitted for this request.`,
      );
    }
    if (runtimeCaps?.hasChatTemplate === false) {
      this.warnOnce(
        `${activeModel.name}:template`,
        `Forge: model "${activeModel.name}" does not expose a usable chat template. Prompt formatting may be mismatched.`,
      );
    }
    const toolDefinitions = budget.filterDefinitions(this.toolRegistry.definitions(allowed));
    const nativeTools = runtimeCaps?.likelySupportsTools !== false;
    if (toolDefinitions.length > 0 && !nativeTools) {
      this.warnOnce(
        `${activeModel.name}:tools`,
        `Forge: model "${activeModel.name}" does not appear to have a tool-aware chat template. Forge will use its fallback tool format.`,
      );
    }
    await runToolCallingLoop({
      baseUrl,
      model: activeModel,
      messages: conv.messages,
      toolDefinitions,
      signal: ctrl.signal,
      maxRounds: MAX_TOOL_ROUNDS,
      nativeTools,
      stripAllTools: useStrip || activeModel.strip_tools === true,
      canUseThinkingKwargs,
      stripThinkingChannels,
      failureTracker: this.failureTracker,
      ...(apiKey ? { apiKey } : {}),
      prepareMessages: (messages) => {
        const tmplCtx: Record<string, string> = {};
        if (activeFile) tmplCtx['activeFile'] = activeFile;
        if (config.custom_instructions) tmplCtx['customInstructions'] = config.custom_instructions;
        if (this.forgeLoader?.root) tmplCtx['workspaceRoot'] = this.forgeLoader.root;
        if (this.forgeLoader?.instructions)
          tmplCtx['forgeInstructions'] = this.forgeLoader.instructions;
        const injected = injectSystemPrompt(
          messages,
          this.templateEngine,
          tmplCtx,
          activeModel.system_prompt,
          activeModel.system_prompt_mode,
        );
        const delegateEnabled = allowed.has('delegate');
        const catalog = delegateEnabled
          ? buildWorkerCatalog(config, allowed.has('cloud-worker'))
          : undefined;
        return addWorkerDelegationInstructions(injected, delegateEnabled, catalog);
      },
      dispatchToolCalls: async (toolCalls, messages) => {
        for (const call of toolCalls) {
          const detail = extractToolDetail(call.function.arguments);
          postC({
            type: 'toolActivity',
            toolName: call.function.name,
            ...(detail ? { detail } : {}),
          });
        }
        await this.toolDispatch.dispatch(
          toolCalls,
          allowed,
          messages,
          conv.id,
          ctrl.signal,
          undefined,
          checkpoint,
          activeModel.name,
          budget,
        );
      },
      onToken: (text) => postC({ type: 'token', text }),
      onReasoning: (text) => postC({ type: 'reasoningToken', text }),
      onDone: (finishReason) => postC({ type: 'done', finishReason }),
      onRepeatedCall: () =>
        postC({
          type: 'error',
          message:
            'Forge: agent is repeating the same tool call — stopping to avoid a loop. Try rephrasing your request or use /compact if the context is full.',
        }),
      onNativeFallback: () =>
        this.warnOnce(
          `${activeModel.name}:native-tool-json`,
          `Forge: llama-server rejected this model's native tool-call JSON. Retrying with Forge's JSON fallback tool format.`,
        ),
    });
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

  private canUseThinkingKwargs(
    model: ModelConfig | undefined,
    runtimeCaps: RuntimeModelCapabilities | undefined,
  ): boolean {
    if (!model) return false;
    if (runtimeCaps?.likelySupportsThinking === false) return false;
    return model.think !== undefined || model.sampling?.preserve_thinking !== undefined;
  }

  private shouldStripThinking(model: ModelConfig | undefined): boolean {
    if (!model || model.think !== false) return false;
    const config = this.getConfig();
    return (model.strip_thinking_channels ?? config.strip_thinking_channels) === true;
  }

  private warnOnce(key: string, message: string): void {
    if (this.capabilityWarningsShown.has(key)) return;
    this.capabilityWarningsShown.add(key);
    void vscode.window.showWarningMessage(message);
  }

  private sanitizeText(text: string, stripThinking: boolean): string {
    const withoutThinking = stripThinking ? stripThinkingFromFullText(text) : text;
    const withoutStructured = stripStructuredOutputFromFullText(withoutThinking);
    return stripHtmlDocumentBoilerplateFromFullText(withoutStructured);
  }
}
