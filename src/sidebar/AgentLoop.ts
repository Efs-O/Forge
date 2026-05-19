import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { BackendController } from '../backend/BackendController';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import { streamModelChatCompletion } from '../llm/ChatClient';
import type { ChatCompletionRequest, ToolCall } from '../llm/types';
import type { AttachmentData } from './messageBridge';
import { buildUserContent } from './ConversationOps';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import { mergeSampling } from '../llm/SamplingMerge';
import { normalizeRequestForModel } from '../llm/RequestNormalizer';
import {
  HtmlDocumentBoilerplateStripper,
  stripHtmlDocumentBoilerplateFromFullText,
} from '../llm/HtmlDocumentBoilerplateStripper';
import { ThinkingChannelStripper, stripThinkingFromFullText } from '../llm/ThinkingChannelStripper';
import { CheckpointStack } from '../checkpoint/CheckpointStack';
import { FORGE_PERMISSIONS, ToolRegistry } from '../tools/ToolRegistry';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import { ToolFailureTracker, stripTools } from '../tools/StripTools';
import { extractFallbackToolCalls } from '../tools/ToolCallFallback';
import { StructuredOutputStripper, stripStructuredOutputFromFullText } from '../tools/StructuredOutputParser';
import { getLogger } from '../util/logger';
import { inspectRuntimeModelCapabilities, type RuntimeModelCapabilities } from '../backend/ModelCapabilities';
import { ToolDispatch } from './ToolDispatch';
import type { DiffDecorations } from './DiffDecorations';
import { deriveTitle } from './sessionTypes';
import { extractToolDetail } from './toolSummary';
const log = getLogger();
const MAX_TOOL_ROUNDS = 20;

export interface SidebarProviderEvents {
  onGenerationStarted?: (modelName: string | null) => void;
  onGenerationFinished?: (modelName: string | null) => void;
  onBackendError?: (message: string) => void;
  onBackendReady?: (modelName: string | null) => void;
  onBackendStopped?: (modelName: string | null) => void;
}

export class AgentLoop {
  private readonly streamingConvIds = new Set<string>();
  private readonly activeBackends = new Map<string, BackendController>();
  private readonly cancelControllers = new Map<string, AbortController>();
  private readonly streamingSettledMap = new Map<string, Promise<void>>();
  private readonly resolveSettledMap = new Map<string, () => void>();
  private readonly capabilityCache = new Map<string, Promise<RuntimeModelCapabilities>>();
  private readonly capabilityWarningsShown = new Set<string>();
  private readonly pendingConfirmations = new Map<string, (approved: boolean) => void>();
  private readonly toolDispatch: ToolDispatch;

  get streaming(): boolean { return this.streamingConvIds.size > 0; }
  isStreamingConv(id: string): boolean { return this.streamingConvIds.has(id); }
  getStreamingIds(): ReadonlySet<string> { return this.streamingConvIds; }

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
    private readonly getView: () => vscode.WebviewView | undefined,
    private readonly templateEngine?: TemplateEngine,
    private readonly forgeLoader?: ForgeInstructionsLoader,
  ) {
    this.toolDispatch = new ToolDispatch(
      toolRegistry,
      checkpoints,
      codeLens,
      failureTracker,
      post,
      (name, detail, isDangerous, convId) => this.requestToolApproval(name, detail, isDangerous, convId),
      diffDecorations,
    );
  }

  async stopStreamingIfNeeded(convId?: string): Promise<void> {
    if (convId) {
      const ctrl = this.cancelControllers.get(convId);
      if (!ctrl) return;
      ctrl.abort();
      try { await this.activeBackends.get(convId)?.stop(); } catch { /* abort is authoritative */ }
      await this.streamingSettledMap.get(convId);
    } else {
      for (const [id, ctrl] of this.cancelControllers) {
        ctrl.abort();
        try { await this.activeBackends.get(id)?.stop(); } catch {}
      }
      await Promise.all([...this.streamingSettledMap.values()]);
    }
  }

  cancel(convId?: string): void {
    if (convId) {
      this.cancelControllers.get(convId)?.abort();
      void this.activeBackends.get(convId)?.stop();
    } else {
      for (const ctrl of this.cancelControllers.values()) ctrl.abort();
      for (const backend of this.activeBackends.values()) void backend.stop();
    }
  }

  resolveConfirmation(id: string, approved: boolean): void {
    const pending = this.pendingConfirmations.get(id);
    if (!pending) return;
    this.pendingConfirmations.delete(id);
    pending(approved);
  }

  clearCapabilityCache(): void { this.capabilityCache.clear(); this.capabilityWarningsShown.clear(); }

  async openFile(filePath: string): Promise<void> { return this.toolDispatch.openFile(filePath); }

  async runTurn(conv: ConversationRuntime, model: ModelConfig, text: string, attachments?: AttachmentData[]): Promise<void> {
    const convId = conv.id;
    const ctrl = new AbortController();
    this.cancelControllers.set(convId, ctrl);
    const settled = new Promise<void>((resolve) => { this.resolveSettledMap.set(convId, resolve); });
    this.streamingSettledMap.set(convId, settled);
    const postC = (msg: HostToWebview): void => this.post({ ...msg, conversationId: convId } as HostToWebview);

    const priorUserCount = conv.messages.filter((m) => m.role === 'user').length;
    conv.active_model = model.name;
    conv.updatedAt = Date.now();
    conv.messages.push({ role: 'user', content: buildUserContent(text, attachments) });
    if (priorUserCount === 0) conv.title = deriveTitle(text.split('\n')[0] ?? text);

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    log.debug(`[AgentLoop] runTurn model=${model.name} conv=${convId}`);

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
    this.checkpoints.beginTurn(turnId);
    this.streamingConvIds.add(convId);
    this.events.onGenerationStarted?.(model.name);
    try {
      await this.runAgentLoop(backend, conv, model, activeFile, ctrl, postC);
    } catch (err) {
      postC({ type: 'error', message: (err as Error).message });
    } finally {
      this.streamingConvIds.delete(convId);
      this.activeBackends.delete(convId);
      conv.updatedAt = Date.now();
      const depthBefore = this.checkpoints.depth();
      this.checkpoints.commitTurn();
      if (this.checkpoints.depth() > depthBefore) postC({ type: 'checkpointReady' });
      this.events.onGenerationFinished?.(model.name);
      this.resolveStreamingLifecycle(convId);
    }
  }

  async runPromptToMarkdown(text: string): Promise<string> {
    const config = this.getConfig();
    const selectedModel = config.models.find((m) => m.name === config.active_model);
    if (!selectedModel) throw new Error('Forge: no active model selected.');

    const backend = await this.pool.acquire(selectedModel.name);
    if (!backend.isReady()) await backend.start();
    this.events.onBackendReady?.(backend.loadedModel());

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const tmplCtx: Record<string, string> = {};
    if (activeFile) tmplCtx['activeFile'] = activeFile;
    if (config.custom_instructions) tmplCtx['customInstructions'] = config.custom_instructions;
    if (this.forgeLoader?.root) tmplCtx['workspaceRoot'] = this.forgeLoader.root;
    if (this.forgeLoader?.instructions) tmplCtx['forgeInstructions'] = this.forgeLoader.instructions;

    const messages = injectSystemPrompt(
      [{ role: 'user', content: text }],
      this.templateEngine,
      tmplCtx,
      selectedModel.system_prompt,
    );
    const base: ChatCompletionRequest = { model: selectedModel.name, messages, stream: true };
    const request = normalizeRequestForModel(
      mergeSampling(base, selectedModel, { allowPreserveThinking: false }),
      selectedModel,
    );

    this.events.onGenerationStarted?.(selectedModel.name);
    let content = '';
    try {
      await new Promise<void>((resolve, reject) => {
        streamModelChatCompletion(backend.baseUrl(), request, selectedModel, {
          onToken: (token) => { content += token; },
          onReasoning: () => {},
          onDone: () => resolve(),
          onError: reject,
          onToolCalls: () => {},
        });
      });
      return this.sanitizeText(content, this.shouldStripThinking(selectedModel));
    } catch (err) {
      this.events.onBackendError?.((err as Error).message);
      throw err;
    } finally {
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
    backend: BackendController,
    conv: ConversationRuntime,
    activeModel: ModelConfig,
    activeFile: string | undefined,
    ctrl: AbortController,
    postC: (msg: HostToWebview) => void,
  ): Promise<void> {
    const config = this.getConfig();
    const allowed = FORGE_PERMISSIONS;
    const useStrip = this.failureTracker.shouldStrip();
    const runtimeCaps = await this.getRuntimeCapabilities(activeModel, backend);
    const canUseThinkingKwargs = this.canUseThinkingKwargs(activeModel, runtimeCaps);
    const stripThinkingChannels = this.shouldStripThinking(activeModel);
    if (useStrip) {
      void vscode.window.showWarningMessage('Forge: tool calls disabled after repeated failures. Restart chat to re-enable.');
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (ctrl.signal.aborted) {
        postC({ type: 'done', finishReason: 'cancelled' });
        return;
      }

      const tmplCtx: Record<string, string> = {};
      if (activeFile) tmplCtx['activeFile'] = activeFile;
      if (config.custom_instructions) tmplCtx['customInstructions'] = config.custom_instructions;
      if (this.forgeLoader?.root) tmplCtx['workspaceRoot'] = this.forgeLoader.root;
      if (this.forgeLoader?.instructions) tmplCtx['forgeInstructions'] = this.forgeLoader.instructions;
      const messages = injectSystemPrompt([...conv.messages], this.templateEngine, tmplCtx, activeModel.system_prompt);

      let toolDefs = this.toolRegistry.definitions(allowed);
      if (activeModel.strip_tools) toolDefs = [];
      if (toolDefs.length > 0 && runtimeCaps?.likelySupportsTools === false) {
        this.warnOnce(`${activeModel.name}:tools`, `Forge: model "${activeModel.name}" does not appear to have a tool-aware chat template. Tools will be omitted for this request.`);
        toolDefs = [];
      }
      if (runtimeCaps?.hasChatTemplate === false) {
        this.warnOnce(`${activeModel.name}:template`, `Forge: model "${activeModel.name}" does not expose a usable chat template. Prompt formatting may be mismatched.`);
      }

      let base: ChatCompletionRequest = {
        model: activeModel.name,
        messages,
        stream: true,
        ...(toolDefs.length > 0 && !useStrip ? { tools: toolDefs } : {}),
        ...(canUseThinkingKwargs && activeModel.think !== undefined
          ? { chat_template_kwargs: {
              ...(activeModel.sampling?.preserve_thinking !== undefined ? { preserve_thinking: activeModel.sampling.preserve_thinking } : {}),
              enable_thinking: activeModel.think,
            } }
          : {}),
      };
      if (!canUseThinkingKwargs && (activeModel.think !== undefined || activeModel.sampling?.preserve_thinking !== undefined)) {
        this.warnOnce(`${activeModel.name}:thinking`, `Forge: model "${activeModel.name}" does not appear to support thinking template toggles. Thinking kwargs will be omitted for this request.`);
      }
      const merged = mergeSampling(base, activeModel, { allowPreserveThinking: canUseThinkingKwargs });
      const request = normalizeRequestForModel(useStrip ? stripTools(merged) : merged, activeModel);

      const thinkingStripper = stripThinkingChannels ? new ThinkingChannelStripper() : null;
      const structuredOutputStripper = new StructuredOutputStripper();
      const htmlStripper = new HtmlDocumentBoilerplateStripper();
      let rawAssistantContent = '';
      let rawReasoningContent = '';

      const { finishReason, toolCalls } = await this.streamOnce(backend.baseUrl(), request, activeModel, (token) => {
        rawAssistantContent += token;
        const withoutToolMarkers = structuredOutputStripper.push(token);
        const withoutHtml = htmlStripper.push(withoutToolMarkers);
        const visible = thinkingStripper ? thinkingStripper.push(withoutHtml) : withoutHtml;
        if (visible) postC({ type: 'token', text: visible });
      }, (reasoningToken) => {
        if (stripThinkingChannels) return;
        rawReasoningContent += reasoningToken;
        postC({ type: 'reasoningToken', text: reasoningToken });
      }, ctrl.signal);

      const trailingTool = structuredOutputStripper.flush();
      const trailingHtml = htmlStripper.push(trailingTool) + htmlStripper.flush();
      const trailing = thinkingStripper ? thinkingStripper.push(trailingHtml) : trailingHtml;
      if (trailing) postC({ type: 'token', text: trailing });

      const assistantContent = this.sanitizeText(rawAssistantContent, stripThinkingChannels);
      const assistantReasoning = stripThinkingChannels ? '' : this.sanitizeText(rawReasoningContent, false);

      if (toolCalls?.length) {
        this.failureTracker.reset();
        for (const tc of toolCalls) {
          const detail = extractToolDetail(tc.function.arguments);
          postC({ type: 'toolActivity', toolName: tc.function.name, ...(detail ? { detail } : {}) });
        }
        conv.messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
        await this.toolDispatch.dispatch(toolCalls, allowed, conv.messages, conv.id);
        continue;
      }

      const fallbackToolCalls = !useStrip && toolDefs.length > 0 && rawAssistantContent
        ? extractFallbackToolCalls(rawAssistantContent)
        : null;
      if (fallbackToolCalls?.length) {
        this.failureTracker.reset();
        for (const tc of fallbackToolCalls) {
          const detail = extractToolDetail(tc.function.arguments);
          postC({ type: 'toolActivity', toolName: tc.function.name, ...(detail ? { detail } : {}) });
        }
        conv.messages.push({ role: 'assistant', content: null, tool_calls: fallbackToolCalls });
        await this.toolDispatch.dispatch(fallbackToolCalls, allowed, conv.messages, conv.id);
        continue;
      }

      if (assistantContent || assistantReasoning) {
        conv.messages.push({
          role: 'assistant',
          content: assistantContent,
          ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
        });
      }
      postC({ type: 'done', finishReason });
      return;
    }
    postC({ type: 'error', message: 'Forge: agent exceeded maximum tool rounds.' });
  }

  private async getRuntimeCapabilities(model: ModelConfig, backend: BackendController): Promise<RuntimeModelCapabilities> {
    const cached = this.capabilityCache.get(model.name);
    if (cached) return cached;
    const pending = inspectRuntimeModelCapabilities(backend.baseUrl(), model);
    this.capabilityCache.set(model.name, pending);
    return pending;
  }

  private canUseThinkingKwargs(model: ModelConfig | undefined, runtimeCaps: RuntimeModelCapabilities | undefined): boolean {
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

  private async requestToolApproval(toolName: string, detail: string, isDangerous?: boolean, convId?: string): Promise<boolean> {
    const view = this.getView();
    if (!view) throw new Error(`Forge: sidebar is unavailable for tool approval (${toolName}).`);
    const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const approved = new Promise<boolean>((resolve) => { this.pendingConfirmations.set(id, resolve); });
    await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
    this.post({ type: 'confirmRequest', id, toolName, detail, ...(isDangerous ? { isDangerous: true } : {}), ...(convId ? { conversationId: convId } : {}) });
    return approved;
  }

  private streamOnce(
    baseUrl: string,
    request: ChatCompletionRequest,
    model: ModelConfig,
    onToken: (token: string) => void,
    onReasoning: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<{ finishReason: string | null; toolCalls: ToolCall[] | null }> {
    return new Promise((resolve, reject) => {
      let capturedToolCalls: ToolCall[] | null = null;
      streamModelChatCompletion(baseUrl, request, model, {
        onToken,
        onReasoning,
        onDone: (reason) => resolve({ finishReason: reason, toolCalls: capturedToolCalls }),
        onError: reject,
        onToolCalls: (calls) => { capturedToolCalls = calls; },
      }, signal);
    });
  }
}
