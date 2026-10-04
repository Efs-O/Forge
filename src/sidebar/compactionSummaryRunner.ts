import type { ChatMessage } from '../llm/types';
import type { PromptRunOptions } from './PromptRun';
import { PromptIncompleteError } from './PromptRun';
import {
  COMPACTION_CHARS_PER_TOKEN,
  fitSummaryPrompt,
  planOutput,
  SummaryPromptFitError,
  type CompactionBudget,
} from './compactionBudget';
import { buildSummaryPrompt, isUsableSummary } from './compactionPrompt';
import { CompactionFailure } from './compactionFailure';
import { renderStagedSource, summarizeInStages } from './compactionStaging';
import type { PlanItem } from './sessionTypes';

const REPLACEMENT_DELIMITER_RESERVE_CHARS = 256;

export interface CompactionSummaryInput {
  messages: ChatMessage[];
  previousSummary?: string;
  recordedFacts: string;
  userContext: string;
  plan?: readonly PlanItem[];
  pinnedFacts: string;
  originalRequest: string;
  exactPendingAction: string;
  modelName?: string;
  modelMaxTokens: number;
  outputLimitTokens: number;
  reasoningTokens: number;
  budget: CompactionBudget;
  maximumSummaryChars: number;
  conversationId: string;
  runPrompt: (text: string, conversationId: string, options: PromptRunOptions) => Promise<string>;
}

export interface CompactionSummaryResult {
  summary: string;
  prompt: string;
  method: 'one-shot' | 'staged';
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
  });
}

export async function summarizeCompaction(
  input: CompactionSummaryInput,
): Promise<CompactionSummaryResult> {
  const outputTokens = visibleOutputLimit(input);
  const useStagingFirst =
    input.modelMaxTokens > 0 &&
    input.budget.policyTokens >= input.modelMaxTokens * 0.75 &&
    renderStagedSource(input.messages).length > input.budget.sourceMaxChars;
  let prompt = '';
  let oneShot = '';
  if (!useStagingFirst) {
    try {
      const fit = oneShotPrompt(input, outputTokens);
      prompt = fit.prompt;
      oneShot = (await runOneShot(input, prompt, outputTokens)).trim();
    } catch (error) {
      if (!(error instanceof PromptIncompleteError) && !(error instanceof SummaryPromptFitError)) {
        throw error;
      }
    }
    if (oneShot && oneShot.length <= input.maximumSummaryChars) {
      if (!isUsableSummary(oneShot)) {
        throw new CompactionFailure(
          'invalid-summary',
          'The summarizer returned no usable summary; previous context kept.',
        );
      }
      return { summary: oneShot, prompt, method: 'one-shot', calls: 1, outputTokens };
    }
  }

  const staged = await summarizeInStages({
    messages: input.messages,
    ...(input.previousSummary ? { previousSummary: input.previousSummary } : {}),
    pinnedFacts: input.pinnedFacts,
    originalRequest: input.originalRequest,
    exactPendingAction: input.exactPendingAction,
    ...(input.modelName ? { modelName: input.modelName } : {}),
    modelMaxTokens: input.modelMaxTokens,
    outputLimitTokens: input.outputLimitTokens,
    reasoningTokens: input.reasoningTokens,
    maximumSummaryChars: input.maximumSummaryChars,
    conversationId: input.conversationId,
    runPrompt: input.runPrompt,
  });
  if (!isUsableSummary(staged.summary)) {
    throw new CompactionFailure(
      'invalid-summary',
      'The staged summarizer returned no usable summary; previous context kept.',
    );
  }
  return {
    summary: staged.summary,
    prompt,
    method: 'staged',
    calls: staged.calls + (oneShot ? 1 : 0),
    outputTokens,
  };
}
