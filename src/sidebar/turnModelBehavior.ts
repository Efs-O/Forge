/**
 * Model-behaviour decisions shared by a full turn and a one-shot prompt run:
 * whether thinking kwargs are usable, whether thinking must be stripped from
 * the visible text, and the template context every request is rendered with.
 */

import type { ForgeConfig, ModelConfig } from '../config/types';
import type { RuntimeModelCapabilities } from '../backend/ModelCapabilities';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
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

export function shouldStripThinking(model: ModelConfig | undefined, config: ForgeConfig): boolean {
  if (!model || model.think !== false) return false;
  return (model.strip_thinking_channels ?? config.strip_thinking_channels) === true;
}

/** Strips everything the user should never see from a completed response. */
export function sanitizeText(text: string, stripThinking: boolean): string {
  const withoutThinking = stripThinking ? stripThinkingFromFullText(text) : text;
  const withoutStructured = stripStructuredOutputFromFullText(withoutThinking);
  return stripHtmlDocumentBoilerplateFromFullText(withoutStructured);
}

/** Variables the system-prompt template is rendered against. */
export function buildTemplateContext(
  config: ForgeConfig,
  forgeLoader: ForgeInstructionsLoader | undefined,
  activeFile: string | undefined,
): Record<string, string> {
  const ctx: Record<string, string> = {};
  if (activeFile) ctx['activeFile'] = activeFile;
  if (config.custom_instructions) ctx['customInstructions'] = config.custom_instructions;
  if (forgeLoader?.root) ctx['workspaceRoot'] = forgeLoader.root;
  if (forgeLoader?.instructions) ctx['forgeInstructions'] = forgeLoader.instructions;
  return ctx;
}
