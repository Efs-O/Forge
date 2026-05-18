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
  public streaming = false;
  private activeBackend: BackendController | null = null;
  private cancelController: AbortController | null = null;
  private streamingSettled: Promise<void> | null = null;
  private resolveStreamingSettled: (() => void) | null = null;
  private readonly capabilityCache = new Map<string, Promise<RuntimeModelCapabilities>>();
  private readonly capabilityWarningsShown = new Set<string>();
  private readonly pendingConfirmations = new Map<string, (approved: boolean) => void>();
  private readonly toolDispatch: ToolDispatch;

  constructor(
    private readonly pool: IBackendPool,
    private readonly getConfig: () => ForgeConfig,
    private readonly toolRegistry: ToolRegistry,
    private readonly checkpoints: CheckpointStack,
    codeLens: KeepUndoCodeLensProvider,
    private readonly failureTracker: ToolFailureTracker,
    private readonly events: SidebarProviderEvents,
    private readonly post: (msg: HostToWebview) => void,
    private readonly getView: () => vscode.WebviewView | undefined,
    private readonly templateEngine?: TemplateEngine,
  ) {
    this.toolDispatch = new ToolDispatch(
      toolRegistry,
      checkpoints,
      codeLens,
      failureTracker,
      post,
      (name, detail, isDangerous) => this.requestToolApproval(name, detail, isDangerous),
    );
  }

  async stopStreamingIfNeeded(): Promise<void> {
    if (!this.streaming && !this.streamingSettled) return;
    this.cancelController?.abort();
    try { await this.activeBackend?.stop(); } catch { /* abort is authoritative */ }
    await this.streamingSettled;
  }

  cancel(): void { this.cancelController?.abort(); void this.activeBackend?.stop(); }

  resolveConfirmation(id: string, approved: boolean): void {
    const pending = this.pendingConfirmations.get(id);
    if (!pending) return;
    this.pendingConfirmations.delete(id);
    pending(approved);
  }

  clearCapabilityCache(): void { this.capabilityCache.clear(); this.capabilityWarningsShown.clear(); }

  async openFile(filePath: string): Promise<void> { return this.toolDispatch.openFile(filePath); }

  async runTurn(conv: ConversationRuntime, model: ModelConfig, text: string, attachments?: AttachmentData[]): Promise<void> {
    this.cancelController = new AbortController();
    this.streamingSettled = new Promise((resolve) => { this.resolveStreamingSettled = resolve; });

    const priorUserCount = conv.messages.filter((m) => m.role === 'user').length;
    conv.active_model = model.name;
    conv.updatedAt = Date.now();
    conv.messages.push({ role: 'user', content: buildUserContent(text, attachments) });
    if (priorUserCount === 0) conv.title = deriveTitle(text.split('\n')[0] ?? text);

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    log.debug(`[AgentLoop] runTurn model=${model.name}`);

    let backend: BackendController;
    try {
      this.post({ type: 'backendStarting', message: 'Starting backend, please wait…' });
      backend = await this.pool.acquire(model.name);
      this.activeBackend = backend;
      this.events.onBackendReady?.(model.name);
      if (this.cancelController.signal.aborted) {
        this.post({ type: 'done', finishReason: 'cancelled' });
        this.resolveStreamingLifecycle();
        return;
      }
      this.post({ type: 'ready' });
    } catch (err) {
      const msg = this.cancelController.signal.aborted
        ? 'Backend start cancelled.'
        : `Backend failed to start: ${(err as Error).message}`;
      this.events.onBackendError?.(msg);
      this.post({ type: 'backendDown', message: msg });
      this.resolveStreamingLifecycle();
      return;
    }

    const turnId = `turn-${Date.now()}`;
    this.checkpoints.beginTurn(turnId);
    this.streaming = true;
    this.events.onGenerationStarted?.(model.name);
    try {
      await this.runAgentLoop(backend, conv, model, activeFile);
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    } finally {
      this.streaming = false;
      this.activeBackend = null;
      conv.updatedAt = Date.now();
      const depthBefore = this.checkpoints.depth();
      this.checkpoints.commitTurn();
      if (this.checkpoints.depth() > depthBefore) this.post({ type: 'checkpointReady' });
      this.events.onGenerationFinished?.(model.name);
      this.resolveStreamingLifecycle();
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

  private resolveStreamingLifecycle(): void {
    this.resolveStreamingSettled?.();
    this.resolveStreamingSettled = null;
    this.streamingSettled = null;
    this.cancelController = null;
  }

  private async runAgentLoop(
    backend: BackendController,
    conv: ConversationRuntime,
    activeModel: ModelConfig,
    activeFile?: string,
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
      if (this.cancelController?.signal.aborted) {
        this.post({ type: 'done', finishReason: 'cancelled' });
        return;
      }

      const tmplCtx: Record<string, string> = {};
      if (activeFile) tmplCtx['activeFile'] = activeFile;
      if (config.custom_instructions) tmplCtx['customInstructions'] = config.custom_instructions;
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
        if (visible) this.post({ type: 'token', text: visible });
      }, (reasoningToken) => {
        if (stripThinkingChannels) return;
        rawReasoningContent += reasoningToken;
        this.post({ type: 'reasoningToken', text: reasoningToken });
      });

      const trailingTool = structuredOutputStripper.flush();
      const trailingHtml = htmlStripper.push(trailingTool) + htmlStripper.flush();
      const trailing = thinkingStripper ? thinkingStripper.push(trailingHtml) : trailingHtml;
      if (trailing) this.post({ type: 'token', text: trailing });

      const assistantContent = this.sanitizeText(rawAssistantContent, stripThinkingChannels);
      const assistantReasoning = stripThinkingChannels ? '' : this.sanitizeText(rawReasoningContent, false);

      if (toolCalls?.length) {
        this.failureTracker.reset();
        for (const tc of toolCalls) {
          const detail = extractToolDetail(tc.function.arguments);
          this.post({ type: 'toolActivity', toolName: tc.function.name, ...(detail ? { detail } : {}) });
        }
        conv.messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
        await this.toolDispatch.dispatch(toolCalls, allowed, conv.messages);
        continue;
      }

      const fallbackToolCalls = !useStrip && toolDefs.length > 0 && rawAssistantContent
        ? extractFallbackToolCalls(rawAssistantContent)
        : null;
      if (fallbackToolCalls?.length) {
        this.failureTracker.reset();
        for (const tc of fallbackToolCalls) {
          const detail = extractToolDetail(tc.function.arguments);
          this.post({ type: 'toolActivity', toolName: tc.function.name, ...(detail ? { detail } : {}) });
        }
        conv.messages.push({ role: 'assistant', content: null, tool_calls: fallbackToolCalls });
        await this.toolDispatch.dispatch(fallbackToolCalls, allowed, conv.messages);
        continue;
      }

      if (assistantContent || assistantReasoning) {
        conv.messages.push({
          role: 'assistant',
          content: assistantContent,
          ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
        });
      }
      this.post({ type: 'done', finishReason });
      return;
    }
    this.post({ type: 'error', message: 'Forge: agent exceeded maximum tool rounds.' });
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

  private async requestToolApproval(toolName: string, detail: string, isDangerous?: boolean): Promise<boolean> {
    const view = this.getView();
    if (!view) throw new Error(`Forge: sidebar is unavailable for tool approval (${toolName}).`);
    const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const approved = new Promise<boolean>((resolve) => { this.pendingConfirmations.set(id, resolve); });
    await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
    this.post({ type: 'confirmRequest', id, toolName, detail, ...(isDangerous ? { isDangerous: true } : {}) });
    return approved;
  }

  private streamOnce(
    baseUrl: string,
    request: ChatCompletionRequest,
    model: ModelConfig,
    onToken: (token: string) => void,
    onReasoning: (token: string) => void,
  ): Promise<{ finishReason: string | null; toolCalls: ToolCall[] | null }> {
    return new Promise((resolve, reject) => {
      let capturedToolCalls: ToolCall[] | null = null;
      streamModelChatCompletion(baseUrl, request, model, {
        onToken,
        onReasoning,
        onDone: (reason) => resolve({ finishReason: reason, toolCalls: capturedToolCalls }),
        onError: reject,
        onToolCalls: (calls) => { capturedToolCalls = calls; },
      }, this.cancelController?.signal);
    });
  }
}
