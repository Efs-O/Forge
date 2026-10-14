/** One percentage policy for summarization and the replacement window. */

import { CHARS_PER_TOKEN } from '../util/contextBudget';

/** Pessimistic conversion for a proposal that has not been tokenized yet. */
export const COMPACTION_CHARS_PER_TOKEN = 2.5;
const SMALL_WINDOW_FLOOR_TOKENS = 20_000;
const REPLACEMENT_SHARE = 0.12;
const SUMMARY_SHARE = 0.55;
const HOST_SHARE = 0.35;
const TAIL_SHARE = 0.1;
const MIN_REPLACEMENT_CHARS = 12_000;
// The 6,000-char host floor cannot fit beside 55% summary and 10% tail shares
// until R is at least 6,000 / 35%. Keep the shares and floor mutually viable.
const MIN_STABLE_REPLACEMENT_CHARS = 17_143;
const MIN_HOST_CHARS = 6_000;

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
  charsPerToken: number;
  tailMaxChars: number;
  hostMaxChars: number;
  replacementMaxChars: number;
}

export function compactionBudget(
  reportedTokens: number,
  activeWindowChars: number,
  modelMaxTokens = 0,
  reasoningTokens = 0,
  charsPerToken = COMPACTION_CHARS_PER_TOKEN,
  windowTokens?: number,
): CompactionBudget {
  const estimatedWindow = Math.ceil(activeWindowChars / CHARS_PER_TOKEN);
  const observedTokens = reportedTokens > 0 ? reportedTokens : estimatedWindow;
  // Service calls provide W explicitly. Omitting it preserves the pre-existing
  // helper contract for non-service callers; the service uses usage only when
  // W is unknown, as marked by maxTokens=0 in its attempt row.
  const stableWindow = windowTokens !== undefined;
  const policyTokens = Math.max(
    SMALL_WINDOW_FLOOR_TOKENS,
    stableWindow ? (windowTokens > 0 ? windowTokens : observedTokens) : observedTokens,
  );
  const sourceTokens = Math.max(SMALL_WINDOW_FLOOR_TOKENS, observedTokens);
  const chars = (tokens: number, fraction: number): number =>
    Math.floor(tokens * fraction * charsPerToken);
  const replacementMaxChars = stableWindow
    ? Math.max(MIN_STABLE_REPLACEMENT_CHARS, chars(policyTokens, REPLACEMENT_SHARE))
    : Math.max(MIN_REPLACEMENT_CHARS, chars(policyTokens, REPLACEMENT_SHARE));
  const summaryCeilingChars = stableWindow
    ? Math.floor(replacementMaxChars * SUMMARY_SHARE)
    : Math.max(MIN_REPLACEMENT_CHARS, chars(policyTokens, REPLACEMENT_SHARE));
  const tailMaxChars = stableWindow
    ? Math.floor(replacementMaxChars * TAIL_SHARE)
    : chars(policyTokens, 0.015);
  const hostMaxChars = stableWindow
    ? Math.max(
        MIN_HOST_CHARS,
        Math.min(
          Math.floor(replacementMaxChars * HOST_SHARE),
          replacementMaxChars - summaryCeilingChars - tailMaxChars,
        ),
      )
    : Math.max(MIN_HOST_CHARS, Math.floor(policyTokens * 0.035 * charsPerToken));
  const summaryTargetTokens = stableWindow
    ? Math.floor((summaryCeilingChars * 0.75) / charsPerToken)
    : Math.max(3_072, Math.floor(policyTokens * 0.06));
  const summaryCeilingTokens = stableWindow
    ? Math.floor(summaryCeilingChars / charsPerToken)
    : Math.max(summaryTargetTokens, Math.floor(policyTokens * REPLACEMENT_SHARE));
  const sourceByPolicy = stableWindow ? chars(sourceTokens, 0.8) : chars(policyTokens, 0.8);
  // Leave the complete replacement allowance, reasoning reserve, and request margin.
  const sourceByModel =
    modelMaxTokens > 0
      ? Math.max(
          0,
          Math.floor(
            (modelMaxTokens - summaryCeilingTokens - reasoningTokens - 6_000) *
              (stableWindow ? charsPerToken : COMPACTION_CHARS_PER_TOKEN),
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
    summaryCeilingChars,
    charsPerToken: stableWindow ? charsPerToken : COMPACTION_CHARS_PER_TOKEN,
    tailMaxChars,
    hostMaxChars,
    replacementMaxChars,
  };
}

/**
 * Adds the first request's own allowance on top of the policy budget. Both the
 * host block and the replacement window grow by the same amount, so the extra
 * text takes no room from later requests, recorded actions or the summary
 * (the summary's allowance remains its reserved share).
 */
export function withFirstRequestAllowance(
  budget: CompactionBudget,
  extraChars: number,
): CompactionBudget {
  if (extraChars <= 0) return budget;
  return {
    ...budget,
    hostMaxChars: budget.hostMaxChars + extraChars,
    replacementMaxChars: budget.replacementMaxChars + extraChars,
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
    const estimatedTokens = Math.ceil(prompt.length / budget.charsPerToken);
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
