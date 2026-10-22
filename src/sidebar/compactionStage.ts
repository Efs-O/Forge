/**
 * One summarize stage of a compaction: host facts, budget and summarizer call
 * for a single split.
 *
 * Split out of `CompactionService.ts` so the service can run it twice — once
 * normally, and once in floor mode when the first run is refused for size
 * before any summarizer call. The service owns when a compaction runs and what
 * is done with the result; this file owns producing a summary for one split.
 */

import type { ChatMessage } from '../llm/types';
import type { CompactionAttemptLogEntry } from './SessionLogger';
import type { CompactionDeps } from './compactionServiceTypes';
import type { ConversationRuntime } from './sessionTypes';
import type { CompactionSplit } from './compactionSplit';
import type { PromptRunOptions } from './PromptRun';
import {
  COMPACTION_CHARS_PER_TOKEN,
  compactionBudget,
  withFirstRequestAllowance,
  type CompactionBudget,
} from './compactionBudget';
import { fitCompactionHostBlock } from './compactionHostFit';
import { CompactionHostContext } from './compactionHostContext';
import {
  compactionResumeNote,
  compactionSummaryAllowance,
  summarizeCompaction,
} from './compactionSummaryRunner';
import { messageCostChars } from './compactionWindow';
import { reportedContextTokens } from '../util/contextBudget';
import { getLogger } from '../util/logger';
import { isPlanFinished } from '../tools/planTools';

const log = getLogger();

/** Small manual compactions may grow; only a substantial window risks a loop. */
export const MIN_WINDOW_CHARS_FOR_FIT_GUARD = 24000;

export interface CompactionStageInput {
  deps: CompactionDeps;
  conv: ConversationRuntime;
  pending: ChatMessage[];
  /** Index of `pending[0]` in `conv.messages`. */
  from: number;
  split: CompactionSplit;
  beforeChars: number;
  modelMax: number;
  thinkingTokens: number;
  outputLimitTokens: number;
  /** Taken once by the service, so a retry does not snapshot the repository again. */
  repoState: string | undefined;
  /** The retry: required host facts at their floors, older transcript shed up front. */
  floorMode: boolean;
  runPrompt: (text: string, conversationId: string, options: PromptRunOptions) => Promise<string>;
  onCalls: (issued: number) => void;
  /** Reported as soon as the host block is fitted, so a later failure still logs it. */
  onHostFields: (fields: Partial<CompactionAttemptLogEntry>) => void;
}

export type CompactionStageResult =
  | { kind: 'not-smaller'; floorChars: number }
  | {
      kind: 'summarized';
      fromIndex: number;
      hostContext: CompactionHostContext;
      budget: CompactionBudget;
      summary: string;
      summaryPrompt: string;
      groupsNote: string;
      /** What the host fit shed, for the reduced-mode notice. */
      shed: string[];
      /** The output cap ended the summary and its complete part was kept. */
      salvagedFromLength: boolean;
    };

export async function runCompactionStage(
  input: CompactionStageInput,
): Promise<CompactionStageResult> {
  const { deps, conv, pending, split, beforeChars, modelMax, thinkingTokens } = input;
  // Derived from the snapshot, NOT from conv.messages.length after the await.
  // Reading the length afterwards put every message appended during the
  // summarization behind the cut: absent from the summary (snapshotted before)
  // and sliced away by applyCompactionWindow — visible in the transcript,
  // invisible to the model.
  const fromIndex = input.from + split.tailStart;
  const hostContext = new CompactionHostContext({
    previous: conv.compaction,
    pending,
    summarize: split.summarize,
    tailStart: split.tailStart,
    fromIndex,
    memoryKeys: deps.listMemoryKeys?.() ?? [],
  });
  if (input.repoState !== undefined) hostContext.optional.repoState = input.repoState;
  const firstRequestExtra = hostContext.firstRequestExtraChars;
  const budgetAt = (ratio?: number): CompactionBudget =>
    withFirstRequestAllowance(
      compactionBudget(
        reportedContextTokens(conv),
        beforeChars,
        modelMax,
        thinkingTokens,
        ratio,
        modelMax,
      ),
      firstRequestExtra,
    );
  let budget = budgetAt();
  const tailChars = pending
    .slice(split.tailStart)
    .reduce((sum, message) => sum + messageCostChars(message), 0);

  // If even an empty summary cannot shrink this window, skip the model call.
  const counter = deps.tokenCountMode?.(conv) ?? (deps.countTokens ? 'count_tokens' : 'estimate');
  const tokenCountEndpoint = deps.tokenCountEndpoint?.(conv);
  const fitBudget = budget;
  const hostFit = await fitCompactionHostBlock({
    optional: hostContext.optional,
    budget: fitBudget,
    budgetForCharsPerToken: budgetAt,
    counter,
    ...(deps.countTokens ? { countTokens: deps.countTokens } : {}),
    ...(tokenCountEndpoint ? { endpoint: tokenCountEndpoint } : {}),
    conv,
    onHostBudget: (hostMaxChars) =>
      hostContext.fitUserContext({
        budget: fitBudget,
        hostMaxChars,
        conversationMessages: conv.messages,
        tailChars,
      }),
    shedRequired: (measure, maxChars) => hostContext.shedRequiredFacts(measure, maxChars),
    floorMode: input.floorMode,
    render: () => hostContext.render(conv.messages, tailChars),
  });
  // Host fitting learns the measured chars/token ratio when token_count is
  // available. Recompute every allowance from that one ratio, not H alone.
  budget = budgetAt(hostFit.charsPerToken);
  input.onHostFields({
    hostChars: hostFit.hostChars,
    hostMaxChars: hostFit.hostMaxChars,
    charsPerToken: hostFit.charsPerToken,
    counter: hostFit.counter,
    components: hostFit.components,
    shed: hostFit.shed,
  });
  if (hostFit.shed.length > 0)
    log.info(`[compact] shed host facts to fit: ${hostFit.shed.join(', ')}`);
  const floorChars = hostFit.floorChars;
  if (beforeChars >= MIN_WINDOW_CHARS_FOR_FIT_GUARD && floorChars >= beforeChars) {
    log.info(
      `[compact] no summary could shrink this window (~${floorChars} vs ~${beforeChars} chars before the summary) — not summarizing`,
    );
    return { kind: 'not-smaller', floorChars };
  }

  const hasOpenPlan = Boolean(
    conv.plan && conv.plan.items.length > 0 && !isPlanFinished(conv.plan.items),
  );
  const groupsNote = compactionResumeNote('', hasOpenPlan);
  const summaryAllowance = compactionSummaryAllowance(budget.summaryCeilingChars, groupsNote);
  const summaryRun = await summarizeCompaction({
    messages: split.summarize,
    ...(conv.compaction?.summary ? { previousSummary: conv.compaction.summary } : {}),
    recordedFacts: hostContext.recordedFactsText,
    userContext: hostContext.userContextText,
    currentLocalTime: deps.currentLocalTime(),
    ...(conv.plan?.items ? { plan: conv.plan.items } : {}),
    ...(conv.active_model ? { modelName: conv.active_model } : {}),
    modelMaxTokens: modelMax,
    outputLimitTokens: input.outputLimitTokens,
    reasoningTokens: thinkingTokens,
    budget,
    maximumSummaryChars: summaryAllowance,
    conversationId: conv.id,
    runPrompt: input.runPrompt,
    onCalls: input.onCalls,
    ...(input.floorMode ? { floorMode: true } : {}),
  });
  log.info(
    `[compact] budget P=${budget.policyTokens} (${budget.estimated ? 'estimated' : 'reported'}), host~${Math.ceil(hostFit.hostChars / COMPACTION_CHARS_PER_TOKEN)}, tail~${Math.ceil(tailChars / COMPACTION_CHARS_PER_TOKEN)}, output_cap=${summaryRun.outputTokens}, summary_max_chars=${summaryAllowance}, method=${summaryRun.method}, calls=${summaryRun.calls}${input.floorMode ? ', floor_mode' : ''}${summaryRun.cutFromChars ? `, summary_cut_from=${summaryRun.cutFromChars}` : ''}${summaryRun.salvagedFromLength ? ', salvaged_from_length' : ''}`,
  );
  return {
    kind: 'summarized',
    fromIndex,
    hostContext,
    budget,
    summary: summaryRun.summary,
    summaryPrompt: summaryRun.prompt,
    groupsNote,
    shed: hostFit.shed,
    salvagedFromLength: summaryRun.salvagedFromLength === true,
  };
}
