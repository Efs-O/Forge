import type { ChatCompletionRequest } from './types';
import type { ModelConfig } from '../config/types';

export interface SamplingDefaults {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  max_tokens?: number;
  seed?: number;
  repeat_penalty?: number;
  repeat_last_n?: number;
  stop?: string | string[];
}

export interface MergeSamplingOptions {
  allowPreserveThinking?: boolean;
}

function modelSamplingOverrides(
  model: ModelConfig | undefined,
  opts: MergeSamplingOptions,
): Partial<ChatCompletionRequest> {
  if (!model?.sampling) return {};

  const {
    temperature,
    top_p,
    top_k,
    min_p,
    max_tokens,
    presence_penalty,
    frequency_penalty,
    seed,
    repetition_penalty,
    repeat_penalty,
    repeat_last_n,
    stop,
    preserve_thinking,
  } = model.sampling;

  const allowPreserveThinking = opts.allowPreserveThinking ?? true;
  const chatTemplateKwargs = !allowPreserveThinking || preserve_thinking === undefined
    ? undefined
    : { preserve_thinking };

  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(top_p !== undefined ? { top_p } : {}),
    ...(top_k !== undefined ? { top_k } : {}),
    ...(min_p !== undefined ? { min_p } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(presence_penalty !== undefined ? { presence_penalty } : {}),
    ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
    ...(repetition_penalty !== undefined ? { repetition_penalty } : {}),
    ...(repeat_penalty !== undefined ? { repeat_penalty } : {}),
    ...(repeat_last_n !== undefined ? { repeat_last_n } : {}),
    ...(stop !== undefined ? { stop } : {}),
    ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
  };
}

const SAMPLING_DEFAULTS: SamplingDefaults = {
  temperature: 0.15,
  top_p: 0.9,
  top_k: 20,
  min_p: 0.05,
  max_tokens: 4096,
};

/**
 * Merges sampling parameters in priority order:
 *   explicit request fields > model overrides > Forge defaults > nothing
 * Fields already set on the request are never overwritten.
 */
export function mergeSampling(
  request: ChatCompletionRequest,
  model?: ModelConfig,
  opts: MergeSamplingOptions = {},
): ChatCompletionRequest {
  const modelOverrides = modelSamplingOverrides(model, opts);
  return {
    ...SAMPLING_DEFAULTS,
    ...modelOverrides,
    ...Object.fromEntries(
      Object.entries(request).filter(([, v]) => v !== undefined),
    ),
  } as ChatCompletionRequest;
}
