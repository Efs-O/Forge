/**
 * How much of the prompt llama-server actually had to evaluate.
 *
 * The original plan for this was a longest-common-prefix differ over
 * consecutive requests. That turned out to be unnecessary: b10430 reports the
 * answer directly, on the endpoint Forge already uses, in the field OpenAI
 * defined for it. Measuring the proxy when the server will hand you the real
 * number is how you end up debugging the proxy.
 *
 * `cached` counts prompt tokens served from the slot's KV cache. A healthy
 * agent turn sits in the high 90s; a sudden drop to 0 on a conversation that
 * only grew means something rewrote the prompt HEAD, and that is a bug in
 * Forge, not in the model. See docs/plans/PROMPT_PREFIX_STABILITY_PLAN.md.
 */

export interface PromptCacheStats {
  promptTokens: number;
  cachedTokens: number;
  /** Tokens the server had to run through the model this request. */
  evaluatedTokens: number;
  /** 0-1. Zero when the prompt is empty, rather than NaN. */
  hitRate: number;
}

/** The `usage` shape is provider-defined, so every field is probed, not typed. */
function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Returns undefined rather than zeroes when the provider does not report cache
 * reuse — a cloud provider, or an older llama.cpp. "Not reported" and "nothing
 * was cached" are opposite diagnoses and must not render the same.
 */
export function readPromptCacheStats(usage: unknown): PromptCacheStats | undefined {
  const promptTokens = readNumber(usage, 'prompt_tokens');
  if (promptTokens === undefined) return undefined;

  const details = (usage as Record<string, unknown>)['prompt_tokens_details'];
  const cachedTokens = readNumber(details, 'cached_tokens');
  if (cachedTokens === undefined) return undefined;

  // Clamped: a provider reporting cached > prompt would otherwise produce a
  // negative "evaluated" that reads as a Forge bug.
  const cached = Math.max(0, Math.min(cachedTokens, promptTokens));
  return {
    promptTokens,
    cachedTokens: cached,
    evaluatedTokens: promptTokens - cached,
    hitRate: promptTokens > 0 ? cached / promptTokens : 0,
  };
}

/** One line, no prompt contents — this runs on every request. */
export function formatPromptCacheStats(stats: PromptCacheStats): string {
  const pct = (stats.hitRate * 100).toFixed(1);
  return (
    `[cache] prompt=${stats.promptTokens} cached=${stats.cachedTokens} (${pct}%) ` +
    `evaluated=${stats.evaluatedTokens}`
  );
}
