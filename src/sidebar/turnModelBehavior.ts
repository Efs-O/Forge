/**
 * Model-behaviour decisions shared by a full turn and a one-shot prompt run:
 * whether thinking kwargs are usable, whether thinking must be stripped from
 * the visible text, and the template context every request is rendered with.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { RuntimeModelCapabilities } from '../backend/ModelCapabilities';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { ChatCompletionRequest, ToolDefinition } from '../llm/types';
import { stripThinkingFromFullText } from '../llm/ThinkingChannelStripper';
import { stripHtmlDocumentBoilerplateFromFullText } from '../llm/HtmlDocumentBoilerplateStripper';
import { stripStructuredOutputFromFullText } from '../tools/StructuredOutputParser';

export function canUseThinkingKwargs(
  model: ModelConfig | undefined,
  runtimeCaps: RuntimeModelCapabilities | undefined,
): boolean {
  if (!model) return false;
  if (runtimeCaps?.likelySupportsThinking === false) return false;
  return model.think !== undefined || model.sampling?.preserve_thinking !== undefined;
}

/**
 * Request fields that turn thinking off for one request, or `undefined` when
 * Forge knows no off switch for the provider.
 *
 * llama.cpp and Ollama take the chat-template kwarg (`RequestNormalizer` keeps
 * an explicit `false`, and maps it to Ollama's `think: false`). Self-hosted
 * OpenAI-compatible servers take `reasoning_effort: 'none'` (Strata maps it to
 * `enable_thinking: false`). The named cloud providers accept different effort
 * vocabularies per model, so a value that one model rejects is not guessed:
 * they get one only from the model's `thinking_off_effort`, which also
 * overrides openai-compatible's 'none'.
 */
export function thinkingOffFields(
  model: ModelConfig,
): Pick<ChatCompletionRequest, 'chat_template_kwargs' | 'reasoning_effort'> | undefined {
  const provider = model.provider ?? 'llama.cpp';
  if (provider === 'llama.cpp' || provider === 'ollama') {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
  if (model.thinking_off_effort !== undefined) {
    return { reasoning_effort: model.thinking_off_effort };
  }
  if (provider === 'openai-compatible') return { reasoning_effort: 'none' };
  return undefined;
}

export function shouldStripThinking(model: ModelConfig | undefined, config: ForgeConfig): boolean {
  if (!model || model.think !== false) return false;
  return (model.strip_thinking_channels ?? config.strip_thinking_channels) === true;
}

/** Strips everything the user should never see from a completed response. */
export function sanitizeText(
  text: string,
  stripThinking: boolean,
  toolNames?: ReadonlySet<string>,
): string {
  const withoutThinking = stripThinking ? stripThinkingFromFullText(text) : text;
  const withoutStructured = stripStructuredOutputFromFullText(withoutThinking, toolNames);
  return stripHtmlDocumentBoilerplateFromFullText(withoutStructured);
}

/** Variables the system-prompt template is rendered against. */
/**
 * The template's check-facts-online rule names web_search/web_fetch, so it is
 * rendered only when one of them is offered. A tool-list change already costs
 * a cold re-prefill, so tying this line to it adds none.
 */
export function hasWebTools(definitions: readonly ToolDefinition[]): boolean {
  return definitions.some(
    ({ function: { name } }) => name === 'web_search' || name === 'web_fetch',
  );
}

export function buildTemplateContext(
  config: ForgeConfig,
  forgeLoader: ForgeInstructionsLoader | undefined,
  activeFile: string | undefined,
  /** A full turn passes its turn-start snapshot; omitted, it is read now. */
  projectRoot?: boolean,
): Record<string, string> {
  const ctx: Record<string, string> = {};
  // `activeFile` is deliberately NOT a template variable any more. Rendering it
  // into the system prompt put volatile state at the prompt head, and one
  // changed line there measured a 12-17x prompt-eval penalty with a KV cache
  // hit of zero. It is injected at the tail now, by `injectTurnContext`.
  // The parameter stays because scoped project instructions are resolved from
  // it below -- that lookup is semantically load-bearing and keeps its place.
  // See docs/plans/PROMPT_PREFIX_STABILITY_PLAN.md.
  if (config.custom_instructions) ctx['customInstructions'] = config.custom_instructions;
  if (forgeLoader?.root) {
    ctx['workspaceRoot'] = forgeLoader.root;
    if (projectRoot ?? isProjectRoot(forgeLoader.root)) ctx['workspaceIsProjectRoot'] = 'true';
  }
  const projectInstructions = forgeLoader?.instructionsFor(activeFile);
  if (projectInstructions) ctx['forgeInstructions'] = projectInstructions;
  return ctx;
}

/**
 * The nested-directory warning in the system prompt is for a workspace that
 * holds a repo below its root. Said to a workspace that IS the project, it sent
 * the model looking for a prefix that does not exist. A turn reads it once: the
 * agent running `git init` mid-turn must not change the system prompt between
 * rounds and cost a cold prefill.
 */
export function isProjectRoot(root: string): boolean {
  return ['.git', 'package.json'].some((marker) => fs.existsSync(path.join(root, marker)));
}
