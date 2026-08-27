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
import type { ForgeConfig } from '../config/types';
import type { ChatCompletionRequest } from '../llm/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { SidebarProviderEvents } from './AgentLoop';
import { streamModelChatCompletion } from '../llm/ChatClient';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import { mergeSampling } from '../llm/SamplingMerge';
import { normalizeRequestForModel } from '../llm/RequestNormalizer';
import { resolveRequestModel } from '../config/ConfigResolver';
import { buildTemplateContext, sanitizeText, shouldStripThinking } from './turnModelBehavior';
import { reasoningReserve } from '../util/contextBudget';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface PromptRunContext {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  events: SidebarProviderEvents;
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
  /** Output room ON TOP of the model's reasoning reserve. Thinking spends from
   *  the same budget, so a bare 4096 can be exhausted before any prose. */
  outputTokens?: number;
  /** Strip thinking channels regardless of `model.think`. A `<think>` block
   *  arriving as `content` would otherwise be stored verbatim. */
  alwaysStripThinking?: boolean;
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

  const backend = await ctx.pool.acquire(selectedModel.name);
  if (!backend.isReady()) await backend.start();
  ctx.events.onBackendReady?.(backend.loadedModel());

  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const messages = options.systemPromptTemplate
    ? injectSystemPrompt(
        [{ role: 'user', content: text }],
        undefined,
        undefined,
        renderReplacementPrompt(ctx, options.systemPromptTemplate),
        'replace',
      )
    : injectSystemPrompt(
        [{ role: 'user', content: text }],
        ctx.templateEngine,
        buildTemplateContext(config, ctx.forgeLoader, activeFile),
        selectedModel.system_prompt,
        selectedModel.system_prompt_mode,
      );
  const base: ChatCompletionRequest = {
    model: selectedModel.name,
    messages,
    stream: true,
    // Set BEFORE mergeSampling, which never overwrites a field already on the
    // request. The reserve is added rather than subtracted: the model spends
    // its thinking out of max_tokens, so a bare 2048 leaves a thinking model
    // nothing to answer with.
    ...(options.outputTokens !== undefined
      ? { max_tokens: reasoningReserve(selectedModel) + options.outputTokens }
      : {}),
  };
  const request = normalizeRequestForModel(
    mergeSampling(base, selectedModel, { allowPreserveThinking: false }),
    selectedModel,
  );

  ctx.events.onGenerationStarted?.(selectedModel.name);
  const ctrl = new AbortController();
  ctx.setController(ctrl, conversationId);
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
    return sanitizeText(
      content,
      options.alwaysStripThinking === true || shouldStripThinking(selectedModel, config),
    );
  } catch (err) {
    ctx.events.onBackendError?.((err as Error).message);
    throw err;
  } finally {
    ctx.releaseController(ctrl);
    ctx.events.onGenerationFinished?.(backend.loadedModel());
  }
}
