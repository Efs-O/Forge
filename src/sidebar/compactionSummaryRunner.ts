import type { ChatMessage } from '../llm/types';
import type { PromptRunOptions } from './PromptRun';
import {
  COMPACTION_CHARS_PER_TOKEN,
  fitSummaryPrompt,
  planOutput,
  type CompactionBudget,
} from './compactionBudget';
import { buildSummaryPrompt, isUsableSummary } from './compactionPrompt';
import { CompactionFailure } from './compactionFailure';
import type { PlanItem } from './sessionTypes';

const REPLACEMENT_DELIMITER_RESERVE_CHARS = 256;

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
}

const PLAN_REFRESH_NOTE =
  'If a plan is shown, check it against the State section and update it with `update_plan` before continuing.';

/** Combine the existing tool-group handoff with instructions for the resumed turn. */
export function compactionResumeNote(groupsNote: string, hasPlan: boolean): string {
  return [groupsNote, ...(hasPlan ? [PLAN_REFRESH_NOTE] : [])].filter(Boolean).join('\n\n');
}

/** Reserve the resume note from the summary's replacement-window allowance. */
export function compactionSummaryAllowance(
  summaryCeilingChars: number,
  replacementMaxChars: number,
  floorChars: number,
  resumeNote: string,
): number {
  return Math.min(summaryCeilingChars, replacementMaxChars - floorChars) - resumeNote.length;
}

export interface CompactionSummaryResult {
  summary: string;
  prompt: string;
  method: 'one-shot';
  calls: number;
  outputTokens: number;
}

function visibleOutputLimit(input: CompactionSummaryInput): number {
  const charsBudget = input.maximumSummaryChars - REPLACEMENT_DELIMITER_RESERVE_CHARS;
  if (charsBudget <= 0) {
    throw new CompactionFailure(
      'budget-refusal',
      'The host facts and retained tail leave no room for a compaction summary; previous context kept.',
    );
  }
  const plan = planOutput(
    Math.floor(charsBudget / COMPACTION_CHARS_PER_TOKEN),
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
        { ...input.budget, sourceMaxChars },
      ),
    input.reasoningTokens,
    outputTokens,
  );
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
    reasoningEffort: 'low',
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
  const outputTokens = visibleOutputLimit(input);
  const { prompt } = oneShotPrompt(input, outputTokens);
  const summary = (await runOneShot(input, prompt, outputTokens)).trim();
  if (summary.length > input.maximumSummaryChars) {
    throw new CompactionFailure(
      'budget-refusal',
      `Summary exceeds its ${input.maximumSummaryChars}-character allocation; previous context kept.`,
    );
  }
  if (!isUsableSummary(summary)) {
    throw new CompactionFailure(
      'invalid-summary',
      'The summarizer returned no usable summary; previous context kept.',
    );
  }
  const missing = ['Goal', 'State', 'Next', 'Files', 'Constraints', 'Errors'].filter(
    (heading) => !new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*(?:\\*\\*)?${heading}\\b`, 'iu').test(summary),
  );
  if (missing.length > 0) {
    throw new CompactionFailure(
      'invalid-summary',
      `Summary is missing required sections: ${missing.join(', ')}; previous context kept.`,
    );
  }
  return { summary, prompt, method: 'one-shot', calls: 1, outputTokens };
}
