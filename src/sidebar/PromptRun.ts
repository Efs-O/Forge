/**
 * A one-shot prompt against the active model, outside any conversation.
 *
 * Used where Forge needs prose from the model rather than a turn: the `/compact`
 * summary, the `/review` scan. No transcript, no tools, no checkpoint — and the
 * result is returned rather than streamed to the webview.
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
import { getLogger } from '../util/logger';

const log = getLogger();

export interface PromptRunContext {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  events: SidebarProviderEvents;
  templateEngine?: TemplateEngine;
  forgeLoader?: ForgeInstructionsLoader;
  /** Publishes the controller so a global cancel can abort this run. */
  setController: (ctrl: AbortController) => void;
  /** Clears it again, but only if a later run has not already replaced it. */
  releaseController: (ctrl: AbortController) => void;
}

export async function runPromptToMarkdown(ctx: PromptRunContext, text: string): Promise<string> {
  const config = ctx.getConfig();
  if (!config.active_model) throw new Error('Forge: no active model selected.');
  // Request-time resolution (defaults + base + @profile, F6).
  const selectedModel = resolveRequestModel(config, config.active_model, (m) => log.info(m));

  const backend = await ctx.pool.acquire(selectedModel.name);
  if (!backend.isReady()) await backend.start();
  ctx.events.onBackendReady?.(backend.loadedModel());

  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const messages = injectSystemPrompt(
    [{ role: 'user', content: text }],
    ctx.templateEngine,
    buildTemplateContext(config, ctx.forgeLoader, activeFile),
    selectedModel.system_prompt,
    selectedModel.system_prompt_mode,
  );
  const base: ChatCompletionRequest = { model: selectedModel.name, messages, stream: true };
  const request = normalizeRequestForModel(
    mergeSampling(base, selectedModel, { allowPreserveThinking: false }),
    selectedModel,
  );

  ctx.events.onGenerationStarted?.(selectedModel.name);
  const ctrl = new AbortController();
  ctx.setController(ctrl);
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
    return sanitizeText(content, shouldStripThinking(selectedModel, config));
  } catch (err) {
    ctx.events.onBackendError?.((err as Error).message);
    throw err;
  } finally {
    ctx.releaseController(ctrl);
    ctx.events.onGenerationFinished?.(backend.loadedModel());
  }
}
