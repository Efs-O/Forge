import type { ChatMessage } from '../llm/types';
import { PromptIncompleteError, type PromptRunOptions } from './PromptRun';
import { fitSummaryPrompt, planOutput, type CompactionBudget } from './compactionBudget';
import {
  buildSummaryPrompt,
  fitSummaryToChars,
  unusableSummaryReason,
  missingSummarySections,
  salvageCutSummary,
} from './compactionPrompt';
import { CompactionFailure, compactionFailureCategory } from './compactionFailure';
import type { PlanItem } from './sessionTypes';

const REPLACEMENT_DELIMITER_RESERVE_CHARS = 256;

/**
 * Output room past the token equivalent of the character allowance.
 *
 * A cap equal to the allowance turned every overshoot into
 * finish_reason=length, so the cut in fitSummaryToChars never ran: a model
 * asked for 75% of the allowance wrote between 66% and 94% of it on the same
 * prompt, and the prompt cannot steer that. The extra room lets it finish and
 * the cut trim the result. It is bounded by the window share so a small
 * window does not lose its transcript source to output it rarely uses.
 */
const OUTPUT_HEADROOM_SHARE = 0.5;
const OUTPUT_HEADROOM_MIN_TOKENS = 4000;
const OUTPUT_HEADROOM_MAX_WINDOW_SHARE = 0.1;

/** The summary's output cap: the allowance in tokens plus bounded headroom. */
export function summaryOutputTokens(
  charsBudget: number,
  charsPerToken: number,
  modelMaxTokens: number,
): number {
  const base = Math.floor(charsBudget / charsPerToken);
  const headroom = Math.max(Math.floor(base * OUTPUT_HEADROOM_SHARE), OUTPUT_HEADROOM_MIN_TOKENS);
  return (
    base +
    (modelMaxTokens > 0
      ? Math.min(headroom, Math.floor(modelMaxTokens * OUTPUT_HEADROOM_MAX_WINDOW_SHARE))
      : headroom)
  );
}

export interface CompactionSummaryInput {
  messages: ChatMessage[];
  currentLocalTime: string;
  previousSummary?: string;
  recordedFacts: string;
  userContext: string;
  plan?: readonly PlanItem[];
  modelName?: string;
  modelMaxTokens: number;
  outputLimitTokens: number;
  reasoningTokens: number;
  budget: CompactionBudget;
  maximumSummaryChars: number;
  conversationId: string;
  runPrompt: (text: string, conversationId: string, options: PromptRunOptions) => Promise<string>;
  /** Called with the running count each time a summarizer call is issued. */
  onCalls?: (issued: number) => void;
  /** The floor-mode retry: the older transcript is shed up front. */
  floorMode?: boolean;
}

const PLAN_REFRESH_NOTE =
  'If a plan is shown, check it against the State section and update it with `update_plan` before continuing.';

/** Combine the existing tool-group handoff with instructions for the resumed turn. */
export function compactionResumeNote(groupsNote: string, hasPlan: boolean): string {
  return [groupsNote, ...(hasPlan ? [PLAN_REFRESH_NOTE] : [])].filter(Boolean).join('\n\n');
}

/**
 * The summary's reserved share less the resume note and the blank line that
 * joins them. Fixed per model: it does not depend on the host block or the
 * tail, so it cannot drift by generation.
 */
export function compactionSummaryAllowance(
  summaryCeilingChars: number,
  resumeNote: string,
): number {
  return summaryCeilingChars - (resumeNote ? resumeNote.length + 2 : 0);
}

export interface CompactionSummaryResult {
  summary: string;
  prompt: string;
  method: 'one-shot';
  calls: number;
  outputTokens: number;
  /** The written length, when the summary was cut down to its allowance. */
  cutFromChars?: number;
  /** The output cap ended the summary and its complete part was kept. */
  salvagedFromLength?: boolean;
}

function visibleOutputLimit(input: CompactionSummaryInput, withHeadroom: boolean): number {
  const charsBudget = input.maximumSummaryChars - REPLACEMENT_DELIMITER_RESERVE_CHARS;
  if (charsBudget <= 0) {
    throw new CompactionFailure(
      'budget-refusal',
      'The host facts and retained tail leave no room for a compaction summary; previous context kept.',
    );
  }
  const plan = planOutput(
    withHeadroom
      ? summaryOutputTokens(charsBudget, input.budget.charsPerToken, input.modelMaxTokens)
      : Math.floor(charsBudget / input.budget.charsPerToken),
    input.reasoningTokens,
    input.outputLimitTokens,
  );
  if (!plan) {
    throw new CompactionFailure(
      'budget-refusal',
      'The provider output limit leaves too little room for thinking plus a safe summary; previous context kept.',
    );
  }
  return plan.outputTokens;
}

function oneShotPrompt(input: CompactionSummaryInput, outputTokens: number) {
  return fitSummaryPrompt(
    input.budget,
    input.modelMaxTokens,
    (sourceMaxChars) =>
      buildSummaryPrompt(
        input.currentLocalTime,
        input.previousSummary,
        input.messages,
        input.recordedFacts,
        input.userContext,
        input.plan,
        {
          sourceMaxChars,
          summaryMaxChars: input.maximumSummaryChars,
          previousSummaryMaxChars: input.budget.summaryCeilingChars,
          ...(input.floorMode ? { floorMode: true } : {}),
        },
      ),
    input.reasoningTokens,
    outputTokens,
  );
}

/**
 * The output cap and the prompt fitted around it. The headroom is spent only
 * when the request still fits the window with it; otherwise the cap is the
 * bare allowance, so a request that fitted before the headroom still fits.
 */
function fittedRequest(input: CompactionSummaryInput): { outputTokens: number; prompt: string } {
  const outputTokens = visibleOutputLimit(input, true);
  try {
    return { outputTokens, prompt: oneShotPrompt(input, outputTokens).prompt };
  } catch (err) {
    const bare = visibleOutputLimit(input, false);
    // Both size refusals: the window check, and the transcript shrinking past
    // its floor while making room for the larger cap.
    if (compactionFailureCategory(err) !== 'budget-refusal' || bare >= outputTokens) throw err;
    return { outputTokens: bare, prompt: oneShotPrompt(input, bare).prompt };
  }
}

async function runOneShot(
  input: CompactionSummaryInput,
  prompt: string,
  outputTokens: number,
): Promise<string> {
  return input.runPrompt(prompt, input.conversationId, {
    ...(input.modelName ? { modelName: input.modelName } : {}),
    systemPromptTemplate: 'summarize',
    outputTokens,
    strictOutputTokens: true,
    alwaysStripThinking: true,
    requireComplete: true,
    partialOnIncomplete: true,
    reasoningEffort: 'low',
    // Thinking and the summary share one output budget, and with no reserve
    // configured the cap holds the visible summary only: a thinking model cut
    // its own summary off with finish_reason=length. The summary is stripped
    // of thinking anyway.
    ...(input.reasoningTokens === 0 ? { disableThinking: true } : {}),
  });
}

export async function summarizeCompaction(
  original: CompactionSummaryInput,
): Promise<CompactionSummaryResult> {
  // Counted at the single choke point, so a call that fails still shows up in
  // the attempt's durable record.
  let issued = 0;
  const input: CompactionSummaryInput = {
    ...original,
    runPrompt: (text, conversationId, options) => {
      issued += 1;
      original.onCalls?.(issued);
      return original.runPrompt(text, conversationId, options);
    },
  };
  const result = await summarizeCompactionCounted(input);
  return { ...result, calls: issued };
}

async function summarizeCompactionCounted(
  input: CompactionSummaryInput,
): Promise<CompactionSummaryResult> {
  const { outputTokens, prompt } = fittedRequest(input);
  let written: string;
  let summary: string | undefined;
  let salvaged = false;
  try {
    written = (await runOneShot(input, prompt, outputTokens)).trim();
    summary = fitSummaryToChars(written, input.maximumSummaryChars);
  } catch (err) {
    // Even with headroom a model can run on; a summary cut inside its last
    // section is still worth more than keeping a window already over its
    // threshold. Anything less complete reports the original failure.
    if (
      !(err instanceof PromptIncompleteError) ||
      err.finishReason !== 'length' ||
      err.partialContent === undefined
    )
      throw err;
    summary = salvageCutSummary(err.partialContent, input.maximumSummaryChars);
    if (summary === undefined) throw err;
    written = err.partialContent.trim();
    salvaged = true;
  }
  if (summary === undefined) {
    throw new CompactionFailure(
      'budget-refusal',
      `Summary exceeds its ${input.maximumSummaryChars}-character allocation even with every section cut; previous context kept.`,
    );
  }
  const unusable = unusableSummaryReason(summary);
  if (unusable !== undefined) {
    throw new CompactionFailure(
      'invalid-summary',
      'The summarizer returned no usable summary; previous context kept.',
      { invalid_reason: 'unusable', invalid_check: unusable, written_chars: written.length },
    );
  }
  // The same heading rule the cut used, so a cut can never drop a heading the
  // check counted.
  const missing = missingSummarySections(summary);
  if (missing.length > 0) {
    throw new CompactionFailure(
      'invalid-summary',
      `Summary is missing required sections: ${missing.join(', ')}; previous context kept.`,
      {
        invalid_reason: 'missing-sections',
        missing_sections: missing,
        written_chars: written.length,
      },
    );
  }
  return {
    summary,
    prompt,
    method: 'one-shot',
    calls: 1,
    outputTokens,
    ...(summary.length < written.length ? { cutFromChars: written.length } : {}),
    ...(salvaged ? { salvagedFromLength: true } : {}),
  };
}
