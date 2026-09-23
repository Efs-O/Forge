import type { ModelConfig } from '../config/types';
import { normalizeRequestForModel } from '../llm/RequestNormalizer';
import { mergeSampling } from '../llm/SamplingMerge';
import type { ChatCompletionRequest, ChatMessage, ToolDefinition } from '../llm/types';
import { withFallbackToolInstructions } from '../tools/FallbackToolPrompt';
import { stripTools } from '../tools/StripTools';
import { applyOutputCap } from './truncationRecovery';

/**
 * One tool-calling round's chat request (SOURCE_SPLIT_PLAN Phase 2).
 *
 * Builds the request the loop streams, and the native-JSON-parse fallback
 * request from the same `base`, so the two cannot drift. The fallback is
 * built from `base`, not from the sampled/capped request: that is how the
 * loop has always sent it.
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
  const base: ChatCompletionRequest = {
    model: model.name,
    messages: nativeDefinitions.length > 0 ? prepared : fallbackMessages,
    stream: true,
    ...(input.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(input.maxOutputTokens !== undefined ? { max_tokens: input.maxOutputTokens } : {}),
    ...(nativeDefinitions.length > 0 ? { tools: nativeDefinitions } : {}),
    ...(input.canUseThinkingKwargs && (model.think !== undefined || suppressThinking)
      ? {
          chat_template_kwargs: {
            ...(model.sampling?.preserve_thinking !== undefined
              ? { preserve_thinking: model.sampling.preserve_thinking }
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
  return {
    request: normalizeRequestForModel(input.stripAllTools ? stripTools(merged) : merged, model),
    fallbackRequest: normalizeRequestForModel(
      stripTools({ ...base, messages: fallbackMessages }),
      model,
    ),
    usesNativeTools: nativeDefinitions.length > 0,
  };
}
