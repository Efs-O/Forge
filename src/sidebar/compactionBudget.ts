/** One percentage policy for summarization and the replacement window. */

import { CHARS_PER_TOKEN } from '../util/contextBudget';

/** Pessimistic conversion for a proposal that has not been tokenized yet. */
export const COMPACTION_CHARS_PER_TOKEN = 2.5;
export const COMPACTION_REQUEST_OUTPUT_TOKENS = 16_384;
const SMALL_WINDOW_FLOOR_TOKENS = 20_000;

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
  const summaryTargetTokens = Math.max(3_072, Math.floor(policyTokens * 0.04));
  const summaryCeilingTokens = Math.max(summaryTargetTokens, Math.floor(policyTokens * 0.05));
  const sourceByPolicy = chars(0.8);
  // Leave the full generation ceiling, reasoning reserve, and request margin.
  const sourceByModel =
    modelMaxTokens > 0
      ? Math.max(
          0,
          Math.floor(
            (modelMaxTokens - COMPACTION_REQUEST_OUTPUT_TOKENS - reasoningTokens - 6_000) *
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
    summaryCeilingChars: Math.max(8_000, chars(0.05)),
    tailMaxChars: chars(0.015),
    hostMaxChars: Math.max(6_000, chars(0.035)),
    replacementMaxChars: Math.max(12_000, chars(0.1)),
  };
}

/** Reduce lossy source room until the complete summarizer request fits. */
export function fitSummaryPrompt(
  budget: CompactionBudget,
  modelMaxTokens: number,
  build: (sourceMaxChars: number) => string,
  reasoningTokens = 0,
): { prompt: string; estimatedTokens: number; sourceMaxChars: number } {
  let sourceMaxChars = budget.sourceMaxChars;
  for (let attempt = 0; attempt < 8; attempt++) {
    const prompt = build(sourceMaxChars);
    const estimatedTokens = Math.ceil(prompt.length / COMPACTION_CHARS_PER_TOKEN);
    if (
      modelMaxTokens <= 0 ||
      estimatedTokens + COMPACTION_REQUEST_OUTPUT_TOKENS + reasoningTokens + 6_000 <= modelMaxTokens
    ) {
      return { prompt, estimatedTokens, sourceMaxChars };
    }
    sourceMaxChars = Math.floor(sourceMaxChars * 0.75);
  }
  throw new Error(
    'Summarization request cannot fit the model window without dropping required task evidence; previous context kept.',
  );
}
