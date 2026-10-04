/** One percentage policy for summarization and the replacement window. */

import { CHARS_PER_TOKEN } from '../util/contextBudget';

/** Pessimistic conversion for a proposal that has not been tokenized yet. */
export const COMPACTION_CHARS_PER_TOKEN = 2.5;
const SMALL_WINDOW_FLOOR_TOKENS = 20_000;

export class SummaryPromptFitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SummaryPromptFitError';
  }
}

export interface CompactionBudget {
  /** Provider usage when available; otherwise an estimate of the active window. */
  observedTokens: number;
  estimated: boolean;
  policyTokens: number;
  sourceMaxChars: number;
  summaryTargetTokens: number;
  summaryCeilingTokens: number;
  summaryCeilingChars: number;
  tailMaxChars: number;
  hostMaxChars: number;
  replacementMaxChars: number;
}

export function compactionBudget(
  reportedTokens: number,
  activeWindowChars: number,
  modelMaxTokens = 0,
  reasoningTokens = 0,
): CompactionBudget {
  const estimatedWindow = Math.ceil(activeWindowChars / CHARS_PER_TOKEN);
  const observedTokens = reportedTokens > 0 ? reportedTokens : estimatedWindow;
  const policyTokens = Math.max(SMALL_WINDOW_FLOOR_TOKENS, observedTokens);
  const chars = (fraction: number): number =>
    Math.floor(policyTokens * fraction * COMPACTION_CHARS_PER_TOKEN);
  const summaryTargetTokens = Math.max(3_072, Math.floor(policyTokens * 0.06));
  const summaryCeilingTokens = Math.max(summaryTargetTokens, Math.floor(policyTokens * 0.12));
  const sourceByPolicy = chars(0.8);
  // Leave the complete replacement allowance, reasoning reserve, and request margin.
  const sourceByModel =
    modelMaxTokens > 0
      ? Math.max(
          0,
          Math.floor(
            (modelMaxTokens - summaryCeilingTokens - reasoningTokens - 6_000) *
              COMPACTION_CHARS_PER_TOKEN,
          ),
        )
      : sourceByPolicy;
  return {
    observedTokens,
    estimated: reportedTokens <= 0,
    policyTokens,
    sourceMaxChars: Math.max(24_000, Math.min(sourceByPolicy, sourceByModel)),
    summaryTargetTokens,
    summaryCeilingTokens,
    summaryCeilingChars: Math.max(12_000, chars(0.12)),
    tailMaxChars: chars(0.015),
    hostMaxChars: Math.max(6_000, chars(0.035)),
    replacementMaxChars: Math.max(12_000, chars(0.12)),
  };
}

export interface OutputPlan {
  /** Value for `PromptRunOptions.outputTokens`; PromptRun adds the reserve on top. */
  outputTokens: number;
  /** The `max_tokens` the request will actually carry: thinking + visible, counted once. */
  requestCap: number;
}

/**
 * Plans one request's output. Thinking and prose share `max_tokens`, so a model
 * with a configured reserve gets visible + reserve (PromptRun adds the reserve).
 * An unbounded-thinking model is still limited to the visible allowance; an
 * incomplete response fails instead of inviting an oversize replacement.
 * Returns undefined when the provider cap cannot hold a useful answer.
 */
export function planOutput(
  visibleTokens: number,
  reasoningTokens: number,
  providerCap: number,
): OutputPlan | undefined {
  if (reasoningTokens > 0) {
    const room = providerCap > 0 ? providerCap - reasoningTokens : visibleTokens;
    const outputTokens = Math.min(visibleTokens, room);
    return outputTokens >= 128
      ? { outputTokens, requestCap: outputTokens + reasoningTokens }
      : undefined;
  }
  if (providerCap > 0) {
    const outputTokens = Math.min(visibleTokens, providerCap);
    return outputTokens >= 128 ? { outputTokens, requestCap: outputTokens } : undefined;
  }
  return visibleTokens >= 128
    ? { outputTokens: visibleTokens, requestCap: visibleTokens }
    : undefined;
}

/** Reduce lossy source room until the complete summarizer request fits. */
export function fitSummaryPrompt(
  budget: CompactionBudget,
  modelMaxTokens: number,
  build: (sourceMaxChars: number) => string,
  reasoningTokens = 0,
  outputTokens = budget.summaryCeilingTokens,
): { prompt: string; estimatedTokens: number; sourceMaxChars: number } {
  let sourceMaxChars = budget.sourceMaxChars;
  for (let attempt = 0; attempt < 8; attempt++) {
    const prompt = build(sourceMaxChars);
    const estimatedTokens = Math.ceil(prompt.length / COMPACTION_CHARS_PER_TOKEN);
    if (
      modelMaxTokens <= 0 ||
      estimatedTokens + outputTokens + reasoningTokens + 6_000 <= modelMaxTokens
    ) {
      return { prompt, estimatedTokens, sourceMaxChars };
    }
    sourceMaxChars = Math.floor(sourceMaxChars * 0.75);
  }
  throw new SummaryPromptFitError(
    'Summarization request cannot fit the model window without dropping required task evidence; previous context kept.',
  );
}
