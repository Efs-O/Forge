import type { ModelConfig } from '../config/types';
import { normalizeRequestForModel } from '../llm/RequestNormalizer';
import { mergeSampling } from '../llm/SamplingMerge';
import type { ChatCompletionRequest, ChatMessage, ToolDefinition } from '../llm/types';
import { withFallbackToolInstructions } from '../tools/FallbackToolPrompt';
import { stripTools } from '../tools/StripTools';
import { templatePreserveThinking } from './preserveThinking';
import { applyOutputCap } from './truncationRecovery';

/**
 * One tool-calling round's chat request (SOURCE_SPLIT_PLAN Phase 2).
 *
 * Builds the request the loop streams, and the native-JSON-parse fallback
 * request from the same `base`, so the two cannot drift. The fallback is
 * built from `base`, not from the sampled/capped request; the loop measures
 * and caps its changed prompt separately if that fallback is needed.
 */
export interface RoundRequestInput {
  model: ModelConfig;
  prepared: ChatMessage[];
  toolDefinitions: ToolDefinition[];
  nativeTools: boolean | undefined;
  stripAllTools: boolean | undefined;
  includeUsage: boolean | undefined;
  maxOutputTokens: number | undefined;
  canUseThinkingKwargs: boolean | undefined;
  suppressThinking: boolean;
  outputRoom: number | undefined;
}

export interface RoundRequest {
  request: ChatCompletionRequest;
  /** Sent when the server cannot parse a native tool call's JSON. */
  fallbackRequest: ChatCompletionRequest;
  /** Whether `request` carries native tool definitions. */
  usesNativeTools: boolean;
}

export function buildRoundRequest(input: RoundRequestInput): RoundRequest {
  const { model, prepared, toolDefinitions, suppressThinking } = input;
  const fallbackMessages =
    toolDefinitions.length > 0 ? withFallbackToolInstructions(prepared, toolDefinitions) : prepared;
  const nativeDefinitions = input.nativeTools && !input.stripAllTools ? toolDefinitions : [];
  const preserveThinkingKwarg = templatePreserveThinking(model);
  const base: ChatCompletionRequest = {
    model: model.name,
    messages: nativeDefinitions.length > 0 ? prepared : fallbackMessages,
    stream: true,
    ...(input.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(suppressThinking && model.provider === 'ollama'
      ? { chat_template_kwargs: { enable_thinking: false } }
      : {}),
    ...(input.maxOutputTokens !== undefined ? { max_tokens: input.maxOutputTokens } : {}),
    ...(nativeDefinitions.length > 0 ? { tools: nativeDefinitions } : {}),
    ...(input.canUseThinkingKwargs && (model.think !== undefined || suppressThinking)
      ? {
          chat_template_kwargs: {
            ...(preserveThinkingKwarg !== undefined
              ? { preserve_thinking: preserveThinkingKwarg }
              : {}),
            enable_thinking: suppressThinking ? false : model.think,
          },
        }
      : {}),
  };
  const merged = applyOutputCap(
    mergeSampling(base, model, {
      allowPreserveThinking: input.canUseThinkingKwargs ?? false,
    }),
    input.outputRoom,
  );
  const primary = input.stripAllTools ? stripTools(merged) : merged;
  return {
    request: normalizeRequestForModel(primary, model),
    // The retry is the SAME round with the tools taken away: it keeps the
    // sampling this model was configured with (temperature, top_p, seed, stop,
    // the output cap). Built from `base` it lost all of it, so a recovery round
    // ran at a different temperature than the one that just failed.
    fallbackRequest: normalizeRequestForModel(
      stripTools({ ...primary, messages: fallbackMessages }),
      model,
    ),
    usesNativeTools: nativeDefinitions.length > 0,
  };
}
