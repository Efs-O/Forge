import type { ChatCompletionRequest } from './types';

export interface SamplingDefaults {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  max_tokens?: number;
  seed?: number;
  repeat_penalty?: number;
}

/** Per-mode sampling defaults tuned for local models. */
const MODE_DEFAULTS: Record<string, SamplingDefaults> = {
  ask:     { temperature: 0.7,  top_p: 0.9, top_k: 40, min_p: 0.05, max_tokens: 2048 },
  plan:    { temperature: 0.4,  top_p: 0.9, top_k: 40, min_p: 0.05, max_tokens: 4096 },
  execute: { temperature: 0.15, top_p: 0.9, top_k: 20, min_p: 0.05, max_tokens: 4096 },
};

/**
 * Merges sampling parameters in priority order:
 *   explicit request fields > mode defaults > nothing
 * Fields already set on the request are never overwritten.
 */
export function mergeSampling(
  request: ChatCompletionRequest,
  mode: string,
): ChatCompletionRequest {
  const defaults = MODE_DEFAULTS[mode] ?? MODE_DEFAULTS['ask'];
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(request).filter(([, v]) => v !== undefined),
    ),
  } as ChatCompletionRequest;
}
