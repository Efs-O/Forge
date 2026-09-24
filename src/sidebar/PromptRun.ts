/**
 * A one-shot prompt against the active model, outside any conversation.
 *
 * Used where Forge needs prose from the model rather than a turn: the `/compact`
 * summary, the `/review` scan. No transcript, no tools, no checkpoint — and the
 * result is returned rather than streamed to the webview. A caller can attach
 * it to a conversation (compaction does) so that conversation's Stop action
 * can cancel the otherwise out-of-band request.
 */

import * as vscode from 'vscode';
import type { BackendController } from '../backend/BackendController';
import type { ForgeConfig } from '../config/types';
import type { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from '../llm/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { SidebarProviderEvents } from './AgentLoop';
import { streamModelChatCompletion } from '../llm/ChatClient';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import { mergeSampling } from '../llm/SamplingMerge';
import { normalizeRequestForModel } from '../llm/RequestNormalizer';
import { resolveRequestModel } from '../config/ConfigResolver';
import { isCloudProvider } from '../llm/CloudProviders';
import { resolveCloudRequestTarget } from '../llm/CloudRequestResolver';
import { buildTemplateContext, sanitizeText, shouldStripThinking } from './turnModelBehavior';
import { reasoningReserve } from '../util/contextBudget';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface PromptRunContext {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  events: SidebarProviderEvents;
  /** Holds cloud provider tokens; a cloud model's run needs one. */
  secrets?: vscode.SecretStorage;
  templateEngine?: TemplateEngine;
  forgeLoader?: ForgeInstructionsLoader;
  /** Publishes the controller so a global or owning-conversation cancel can abort this run. */
  setController: (ctrl: AbortController, conversationId?: string) => void;
  /** Clears it again, but only if a later run has not already replaced it. */
  releaseController: (ctrl: AbortController) => void;
}

/**
 * Per-caller overrides. Every field is optional and every existing caller
 * passes none, so `/review`, `/initForge` and `commandHelpers` are unaffected.
 *
 * These exist because compaction needs a different request shape from the rest:
 * measured, not assumed — a minimal system prompt scored 1.00 written-file
 * recall against the agent persona's 0.81, with zero fabricated paths and no
 * run-to-run variance (docs/plans/COMPACTION_SUMMARIZER_REQUEST_PLAN.md).
 *
 * There is deliberately no `disableThinking`: the same measurement put thinking
 * at ~0.40 recall on this task. Do not add one.
 */
export interface PromptRunOptions {
  /** Model to serve this run. Defaults to `config.active_model`. */
  modelName?: string;
  /** Template rendered as the ONLY system message — no execute persona, no
   *  FORGE.md, no workspace facts. Sent in `replace` mode. */
  systemPromptTemplate?: string;
  /** Literal replacement system prompt, used by isolated contact requests. */
  systemPromptText?: string;
  /** Output room ON TOP of the model's reasoning reserve. Thinking spends from
   *  the same budget, so a bare 4096 can be exhausted before any prose. */
  outputTokens?: number;
  /** Strip thinking channels regardless of `model.think`. A `<think>` block
   *  arriving as `content` would otherwise be stored verbatim. */
  alwaysStripThinking?: boolean;
  /** Already-held backend for host-owned non-evicting runs. */
  backend?: BackendController;
  /** Narrow, caller-owned tools for an isolated prompt. */
  contactTools?: readonly ToolDefinition[];
  /** Dispatches only the narrow tools advertised in `contactTools`. */
  dispatchContactTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Maximum tool rounds for an isolated prompt. Defaults to three. */
  maxContactToolRounds?: number;
}

/**
 * The system message for a run that replaces the agent persona.
 *
 * Throws rather than falling back to the persona: silently reinstating it is
 * the exact defect this option exists to remove, and it is the failure mode
 * that made a model answer a summarization request with a `read_file` tool
 * call.
 */
function renderReplacementPrompt(ctx: PromptRunContext, template: string): string {
  if (!ctx.templateEngine) {
    throw new Error(`Forge: no template engine available to render '${template}'.`);
  }
  const rendered = ctx.templateEngine.render(template, {}).trim();
  if (!rendered) throw new Error(`Forge: template '${template}' rendered empty.`);
  return rendered;
}

function replacementPrompt(ctx: PromptRunContext, options: PromptRunOptions): string | undefined {
  if (options.systemPromptText !== undefined) {
    const text = options.systemPromptText.trim();
    if (!text) throw new Error('Forge: replacement system prompt is empty.');
    return text;
  }
  return options.systemPromptTemplate
    ? renderReplacementPrompt(ctx, options.systemPromptTemplate)
    : undefined;
}

/**
 * `max_tokens` for a run that asked for `outputTokens` of prose.
 *
 * Thinking spends from the same budget, so the model's reasoning reserve is
 * added on top. A cloud model has no `--reasoning-budget` to read that reserve
 * from, and its thinking is unbounded: on 2026-09-22 Cerebras Qwen spent all
 * 3,072 tokens of every compaction summary thinking, wrote nothing, and
 * auto-compaction retried it every round. A thinking model with no reserve gets
 * its own configured output cap instead, when that is larger.
 */
function outputBudget(model: ReturnType<typeof resolveRequestModel>, outputTokens: number): number {
  const reserve = reasoningReserve(model);
  if (reserve > 0 || model.think === false) return reserve + outputTokens;
  return Math.max(model.sampling?.max_tokens ?? 0, outputTokens);
}

interface RunTarget {
  baseUrl: string;
  loadedModel: string | null;
  apiKey?: string;
}

/**
 * Where the run's request goes. A cloud model has no local server: acquiring
 * one from the pool tried to spawn llama-server for it, so `/compact` on a
 * Cerebras chat failed with "missing gguf_path for llama.cpp".
 */
async function resolveRunTarget(
  ctx: PromptRunContext,
  model: ReturnType<typeof resolveRequestModel>,
  reserved: BackendController | undefined,
): Promise<RunTarget> {
  if (!reserved && isCloudProvider(model.provider)) {
    const { baseUrl, apiKey } = await resolveCloudRequestTarget(model, ctx.secrets);
    return { baseUrl, apiKey, loadedModel: model.name };
  }
  const backend = reserved ?? (await ctx.pool.acquire(model.name));
  if (!backend.isReady()) {
    if (reserved) throw new Error('Forge: reserved contact backend is not ready.');
    await backend.start();
  }
  return { baseUrl: backend.baseUrl(), loadedModel: backend.loadedModel() };
}

export async function runPromptToMarkdown(
  ctx: PromptRunContext,
  text: string,
  conversationId?: string,
  options: PromptRunOptions = {},
): Promise<string> {
  const config = ctx.getConfig();
  const requested = options.modelName ?? config.active_model;
  if (!requested) throw new Error('Forge: no active model selected.');
  // Request-time resolution (defaults + base + @profile, F6).
  const selectedModel = resolveRequestModel(config, requested, (m) => log.info(m));

  const target = await resolveRunTarget(ctx, selectedModel, options.backend);
  ctx.events.onBackendReady?.(target.loadedModel);

  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const replacement = replacementPrompt(ctx, options);
  let messages: ChatMessage[] = replacement
    ? injectSystemPrompt(
        [{ role: 'user', content: text }],
        undefined,
        undefined,
        replacement,
        'replace',
      )
    : injectSystemPrompt(
        [{ role: 'user', content: text }],
        ctx.templateEngine,
        buildTemplateContext(config, ctx.forgeLoader, activeFile),
        selectedModel.system_prompt,
        selectedModel.system_prompt_mode,
      );
  const ctrl = new AbortController();
  ctx.setController(ctrl, conversationId);
  const maxToolRounds = Math.max(0, Math.min(options.maxContactToolRounds ?? 3, 3));
  try {
    for (let toolRound = 0; ; toolRound += 1) {
      const base: ChatCompletionRequest = {
        model: selectedModel.name,
        messages,
        stream: true,
        // Set BEFORE mergeSampling, which never overwrites a field already on the
        // request. The reserve is added rather than subtracted: the model spends
        // its thinking out of max_tokens, so a bare 2048 leaves a thinking model
        // nothing to answer with.
        ...(options.outputTokens !== undefined
          ? { max_tokens: outputBudget(selectedModel, options.outputTokens) }
          : {}),
        ...(options.contactTools && options.dispatchContactTool
          ? { tools: [...options.contactTools] }
          : {}),
      };
      const request = normalizeRequestForModel(
        mergeSampling(base, selectedModel, { allowPreserveThinking: false }),
        selectedModel,
      );

      ctx.events.onGenerationStarted?.(selectedModel.name);
      let content = '';
      let reasoningChars = 0;
      let finishReason: string | null = null;
      let toolCalls: ToolCall[] = [];
      await new Promise<void>((resolve, reject) => {
        streamModelChatCompletion(
          target.baseUrl,
          request,
          selectedModel,
          {
            onToken: (token) => {
              content += token;
            },
            onReasoning: (token) => {
              reasoningChars += token.length;
            },
            onDone: (reason) => {
              finishReason = reason;
              resolve();
            },
            onError: reject,
            onToolCalls: (calls) => {
              toolCalls = calls;
            },
          },
          ctrl.signal,
          target.apiKey,
        );
      });
      ctx.events.onGenerationFinished?.(target.loadedModel);
      if (!content.trim() && reasoningChars > 0 && finishReason === 'length') {
        // An empty answer otherwise reaches the caller as "no summary", which
        // names neither the cause nor the fix; retrying just repeats it.
        throw new Error(
          `"${selectedModel.name}" spent its whole ${request.max_tokens ?? 'default'}-token output ` +
            'budget thinking and wrote no answer. Raise its sampling.max_tokens in config.yaml.',
        );
      }
      if (
        toolCalls.length === 0 ||
        !options.contactTools ||
        !options.dispatchContactTool ||
        toolRound >= maxToolRounds
      ) {
        return sanitizeText(
          content,
          options.alwaysStripThinking === true || shouldStripThinking(selectedModel, config),
          // Tools here are native only, so no ```json block in the answer is a call.
          new Set(),
        );
      }
      messages = [
        ...messages,
        { role: 'assistant', content: content || null, tool_calls: toolCalls },
      ];
      for (const call of toolCalls) {
        let result: string;
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          result = await options.dispatchContactTool(call.function.name, args);
        } catch (error) {
          result = `Contact web tool failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: result,
        });
      }
    }
  } catch (err) {
    ctx.events.onBackendError?.((err as Error).message);
    throw err;
  } finally {
    ctx.releaseController(ctrl);
  }
}
