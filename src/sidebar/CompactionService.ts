/**
 * Compaction execution: turning a conversation into a summary + verbatim tail.
 *
 * Sole owner of *how* a compaction is produced. `compactionWindow.ts` owns how
 * the recorded result is applied at request time; this file owns choosing the
 * cut point, building the summarization prompt, and running it.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { CompactionAttemptLogEntry } from './SessionLogger';
import type {
  CompactionDeps,
  CompactionOptions,
  CompactionOutcome,
  CompactionTrigger,
} from './compactionServiceTypes';
import { runCompactionWithPolicy } from './compactionAttemptPolicy';
import { compactionRefusalNotice } from './compactionRefusal';
import { capSummary, isUsableSummary } from './compactionPrompt';
import { COMPACTION_CHARS_PER_TOKEN, compactionBudget } from './compactionBudget';
import {
  CompactionFailure,
  compactionFailureCategory,
  type CompactionFailureCategory,
} from './compactionFailure';
import {
  refuseHostFacts,
  shedOptionalHostFacts,
  type OptionalHostFacts,
} from './compactionHostFit';
import { summarizeCompaction } from './compactionSummaryRunner';
import { PromptIncompleteError } from './PromptRun';
import {
  collectRecordedActions,
  mergeRecordedActions,
  renderRecordedActionsBlock,
} from './compactionLedger';
import {
  collectCompactionUserMessages,
  renderCompactionUserMessages,
} from './compactionUserContext';
import { getLogger } from '../util/logger';
import { collectLastReply, toolActivityFollowedLastReply } from './compactionLastReply';
import { selectCompactionSplit } from './compactionSplit';
import { reportedContextTokens } from '../util/contextBudget';
import { boundMemoryKeys, compactionWindowChars, messageCostChars } from './compactionWindow';
import type { CompactionState } from './compactionTypes';
import { deactivateLazyGroups, lazyGroupSummaryNote } from '../tools/lazyToolGroups';
import { resetContextTrimState } from '../agent/toolResultContext';

const log = getLogger();

export type {
  CompactionDeps,
  CompactionEvent,
  CompactionOptions,
  CompactionOutcome,
  CompactionTrigger,
} from './compactionServiceTypes';

/** Neutral user-role trigger. Task state lives in the replacement context;
 * references to a "checkpoint" or a possibly absent section caused prior
 * agents to hunt for nonexistent state after compaction. */
export const RESUME_PROMPT = 'Continue the active task from the compacted context.';

/** Consecutive auto-resumes allowed without an intervening user prompt. */
export const MAX_CONSECUTIVE_AUTO_CONTINUES = 2;

/** Small manual compactions may grow; only a substantial window risks a loop. */
export const MIN_WINDOW_CHARS_FOR_FIT_GUARD = 24000;

/**
 * Runs one compaction against the active conversation.
 *
 * `auto` changes the messaging (an automatic compaction the user did not ask
 * for should not pop modal-ish information toasts) and applies the automatic
 * retry-after-failure policy.
 */
export function runCompaction(
  deps: CompactionDeps,
  conversationId: string,
  options: CompactionOptions = { auto: false },
): Promise<CompactionOutcome> {
  return runCompactionWithPolicy(deps, conversationId, options, compactOnce);
}

function userText(message: { content: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function compactOnce(
  deps: CompactionDeps,
  conversationId: string,
  options: CompactionOptions,
): Promise<CompactionOutcome> {
  const trigger: CompactionTrigger = options.trigger ?? 'sidebar';
  const callerCategory = options.onFailureCategory;
  let attemptCategory: CompactionFailureCategory | undefined;
  let attemptCalls: number | undefined;
  let attemptFinish: string | undefined;
  options = {
    ...options,
    onFailureCategory: (category) => {
      attemptCategory = category;
      callerCategory?.(category);
    },
  };
  const remoteOrigin = options.trigger === 'remote' ? options.remoteOrigin : undefined;
  const midTurn = options.midTurn === true;
  if (!midTurn && deps.isStreaming(conversationId)) {
    void vscode.window.showInformationMessage(
      'Forge: wait for the current response to finish before compacting.',
    );
    return 'skipped';
  }
  const conv = deps.getConversation(conversationId);
  if (!conv) {
    deps.post({
      type: 'error',
      message: 'Forge: the conversation to compact is no longer open.',
      conversationId,
    });
    return 'failed';
  }
  // Only summarize what the model is actually still being sent: re-compacting
  // must not re-summarize turns already folded into the previous summary.
  const from = conv.compaction ? Math.min(conv.compaction.fromIndex, conv.messages.length) : 0;
  const pending = conv.messages.slice(from);
  const beforeChars = compactionWindowChars(conv.messages, conv.compaction);
  const metrics = deps.compactionMetrics?.(conv);
  const modelMax = metrics?.max ?? 0;
  const thinkingTokens = metrics?.reasoningReserve ?? 0;
  const budget = compactionBudget(
    reportedContextTokens(conv),
    beforeChars,
    modelMax,
    thinkingTokens,
  );
  const split = selectCompactionSplit(pending, budget.tailMaxChars);
  if (!split) {
    if (!options.auto) {
      void vscode.window.showInformationMessage(
        'Forge: not enough conversation history to compact.',
      );
    }
    return 'skipped';
  }

  // Derived from the snapshot, NOT from conv.messages.length after the await.
  // Reading the length afterwards put every message appended during the
  // summarization behind the cut: absent from the summary (snapshotted before)
  // and sliced away by applyCompactionWindow — visible in the transcript,
  // invisible to the model.
  const fromIndex = from + split.tailStart;
  const currentActions = collectRecordedActions(split.summarize);
  const merged = mergeRecordedActions(
    conv.compaction?.recordedActions,
    currentActions,
    conv.compaction?.omittedActions,
  );
  const recordedActions = merged.actions;
  const omittedActions = merged.omitted;
  const recordedActionsText = renderRecordedActionsBlock(recordedActions, omittedActions);
  const userMessages = collectCompactionUserMessages(
    conv.compaction?.userMessages,
    split.summarize,
  );
  const userContext = renderCompactionUserMessages(userMessages);
  // Only when the retained tail has no words of the agent's own. A tail that
  // carries them needs no copy; a tail that is empty, or is a user turn whose
  // answer had not started yet, leaves the summarizer's paraphrase as the sole
  // account of what the user was last told.
  const optional: OptionalHostFacts = {
    repoState: '',
    memoryKeys: boundMemoryKeys(deps.listMemoryKeys?.() ?? []),
    lastReply: collectLastReply(pending.slice(split.tailStart))
      ? undefined
      : collectLastReply(split.summarize),
  };
  // Recorded with the reply, because the transcript it was derived from is not
  // available when the block is rendered on a later turn. The retained tail
  // counts too: a tail of tool calls with no text of its own ran after the reply.
  const lastReplyFollowedByTools = optional.lastReply
    ? toolActivityFollowedLastReply([...split.summarize, ...pending.slice(split.tailStart)])
    : false;

  // Everything the candidate state will carry except the summary itself. Built
  // here so the floor check below can run BEFORE the summarization request.
  const candidateWithSummary = (summaryText: string): CompactionState => ({
    summary: summaryText,
    fromIndex,
    generation: (conv.compaction?.generation ?? 0) + 1,
    ...(userMessages.length > 0 ? { userMessages } : {}),
    ...(recordedActions.length > 0 ? { recordedActions } : {}),
    ...(omittedActions.file > 0 || omittedActions.command > 0 ? { omittedActions } : {}),
    ...(optional.repoState ? { repoState: optional.repoState } : {}),
    ...(optional.memoryKeys.length > 0 ? { memoryKeys: optional.memoryKeys } : {}),
    ...(optional.lastReply ? { lastReply: optional.lastReply } : {}),
    ...(optional.lastReply && lastReplyFollowedByTools ? { lastReplyFollowedByTools } : {}),
  });

  deps.post({ type: 'notice', message: 'Compacting conversation…', conversationId: conv.id });
  // The webview treats the conversation as streaming between these two, so a
  // prompt typed during the summarization is queued and flushed after it rather
  // than racing the cut point.
  if (!midTurn) deps.post({ type: 'generationStarted', conversationId: conv.id });
  const release = midTurn ? () => undefined : deps.beginCompaction(conv.id);
  // 'started' only after the split is valid — pre-start skips/failures (no
  // conversation, not enough history, still streaming) emit nothing, so the
  // remote layer never reports progress for a compaction that never began.
  deps.emitCompactionEvent?.({
    conversationId: conv.id,
    phase: 'started',
    trigger,
    ...(remoteOrigin ? { remoteOrigin } : {}),
  });
  const attemptId = randomUUID();
  const usedAtStart = reportedContextTokens(conv);
  const logAttempt = (
    entry: Pick<CompactionAttemptLogEntry, 'phase'> & Partial<CompactionAttemptLogEntry>,
  ): void => {
    try {
      deps.logCompactionAttempt?.(conv, {
        attemptId,
        trigger,
        usedTokens: usedAtStart,
        maxTokens: modelMax,
        ...entry,
      });
    } catch (err) {
      log.info(`[compact] attempt log failed — ${(err as Error).message}`);
    }
  };
  logAttempt({ phase: 'start' });
  let summary = '';
  let summaryPrompt = '';
  let groupsNote = '';
  let outcome: CompactionOutcome = 'failed';
  try {
    try {
      // Keep the conversation busy while the bounded snapshot runs. Awaiting it
      // before beginCompaction left a window in which a new turn could start and
      // invalidate the cut point we just selected.
      const tailChars = pending
        .slice(split.tailStart)
        .reduce((sum, message) => sum + messageCostChars(message), 0);
      if (deps.snapshotRepoState) {
        try {
          optional.repoState = await deps.snapshotRepoState();
        } catch (err) {
          // Evidence is optional even when an injected implementation is faulty.
          // The real snapshotter already catches its own git errors; this guard
          // preserves CompactionDeps' promise that it can never block compaction.
          log.info(`[compact] repo snapshot unavailable — ${(err as Error).message}`);
        }
      }
      // If even an empty summary cannot shrink this window, skip the model call.
      const measureHost = (): number =>
        compactionWindowChars(conv.messages, candidateWithSummary('')) - tailChars;
      const shed = shedOptionalHostFacts(optional, measureHost, budget.hostMaxChars);
      if (shed.length > 0)
        log.info(`[compact] shed optional host facts to fit: ${shed.join(', ')}`);
      const floorChars = compactionWindowChars(conv.messages, candidateWithSummary(''));
      const hostChars = floorChars - tailChars;
      if (hostChars > budget.hostMaxChars) {
        refuseHostFacts(hostChars, budget.hostMaxChars, {
          'user requests': userContext.length,
          'recorded actions': recordedActionsText.length,
          'repo state': optional.repoState.length,
          'last reply': optional.lastReply?.length ?? 0,
        });
      }
      if (beforeChars >= MIN_WINDOW_CHARS_FOR_FIT_GUARD && floorChars >= beforeChars) {
        log.info(
          `[compact] no summary could shrink this window (~${floorChars} vs ~${beforeChars} chars before the summary) — not summarizing`,
        );
        deps.post({
          type: 'notice',
          message: compactionRefusalNotice(floorChars, beforeChars, midTurn),
          conversationId: conv.id,
        });
        options.onFailureCategory?.('budget-refusal');
        return 'failed';
      }

      groupsNote = lazyGroupSummaryNote(conversationId);
      const summaryAllowance =
        Math.min(budget.summaryCeilingChars, budget.replacementMaxChars - floorChars) -
        (groupsNote?.length ?? 0);
      const exactPendingAction = [...pending]
        .reverse()
        .find((message) => message.role === 'user' && message.internal !== true);
      const originalRequest = split.summarize.find(
        (message) => message.role === 'user' && message.internal !== true,
      );
      const outputLimitTokens = metrics?.outputLimitTokens ?? 0;
      const summaryRun = await summarizeCompaction({
        messages: split.summarize,
        ...(conv.compaction?.summary ? { previousSummary: conv.compaction.summary } : {}),
        recordedFacts: recordedActionsText + optional.repoState,
        userContext,
        ...(conv.plan?.items ? { plan: conv.plan.items } : {}),
        pinnedFacts: recordedActionsText + optional.repoState + userContext,
        originalRequest: originalRequest ? userText(originalRequest) : '',
        exactPendingAction: exactPendingAction ? userText(exactPendingAction) : '',
        ...(conv.active_model ? { modelName: conv.active_model } : {}),
        modelMaxTokens: modelMax,
        outputLimitTokens,
        reasoningTokens: thinkingTokens,
        budget,
        maximumSummaryChars: summaryAllowance,
        conversationId: conv.id,
        runPrompt: async (text, id, promptOptions) => {
          try {
            return await deps.runPromptToMarkdown(text, id, promptOptions);
          } catch (err) {
            // The summarizer may recover from a cut-off call; keep the reason.
            if (err instanceof PromptIncompleteError) attemptFinish = err.finishReason ?? 'none';
            throw err;
          }
        },
        onCalls: (issued) => {
          attemptCalls = issued;
        },
      });
      summaryPrompt = summaryRun.prompt;
      summary = summaryRun.summary;
      log.info(
        `[compact] budget P=${budget.policyTokens} (${budget.estimated ? 'estimated' : 'reported'}), host~${Math.ceil(hostChars / COMPACTION_CHARS_PER_TOKEN)}, tail~${Math.ceil(tailChars / COMPACTION_CHARS_PER_TOKEN)}, output_cap=${summaryRun.outputTokens}, summary_target=${budget.summaryTargetTokens}, method=${summaryRun.method}, calls=${summaryRun.calls}`,
      );
    } finally {
      release();
      if (!midTurn) deps.post({ type: 'done', finishReason: 'stop', conversationId: conv.id });
    }

    const proposed = groupsNote ? `${summary.trim()}\n\n${groupsNote}` : summary.trim();
    const summaryAllowance = Math.min(
      budget.summaryCeilingChars,
      budget.replacementMaxChars - compactionWindowChars(conv.messages, candidateWithSummary('')),
    );
    if (proposed.length > summaryAllowance) {
      throw new CompactionFailure(
        'budget-refusal',
        `Summary exceeds its ${summaryAllowance}-character allocation within the whole-replacement budget; previous context kept.`,
      );
    }
    const trimmed = capSummary(proposed, summaryAllowance);
    if (!isUsableSummary(trimmed)) {
      log.info(`[compact] rejected unusable summary (${trimmed.length} chars)`);
      options.onFailureCategory?.('invalid-summary');
      void vscode.window.showWarningMessage(
        trimmed
          ? 'Forge: compaction produced no usable summary — context is unchanged.'
          : 'Forge: compaction returned no summary.',
      );
      return 'failed';
    }

    // Non-destructive: record the summary and the cut point instead of
    // overwriting the transcript. conv.messages stays whole, so the sidebar
    // scrollback and the persisted record survive; only what the model is sent
    // shrinks (see applyCompactionWindow).
    // Read before the assignment below overwrites conv.compaction, and shared
    // with the log row so the two can never disagree about which generation
    // this was.
    const generation = (conv.compaction?.generation ?? 0) + 1;
    const candidate = candidateWithSummary(trimmed);

    // Does the candidate actually shrink the window?
    //
    // The returned summary can be long enough to undo the estimated reduction.
    const afterChars = compactionWindowChars(conv.messages, candidate);
    if (afterChars > budget.replacementMaxChars) {
      throw new CompactionFailure(
        'budget-refusal',
        `Replacement context needs an estimated ${afterChars} characters, above its ${budget.replacementMaxChars}-character budget; previous context kept.`,
      );
    }
    if (beforeChars >= MIN_WINDOW_CHARS_FOR_FIT_GUARD && afterChars >= beforeChars) {
      log.info(
        `[compact] candidate window is not smaller (~${afterChars} vs ~${beforeChars} chars) — keeping the previous state`,
      );
      deps.post({
        type: 'notice',
        message: compactionRefusalNotice(afterChars, beforeChars, midTurn),
        conversationId: conv.id,
      });
      options.onFailureCategory?.('budget-refusal');
      return 'failed';
    }
    log.info(
      `[compact] replacement~${Math.ceil(afterChars / COMPACTION_CHARS_PER_TOKEN)} estimated tokens, summary=${trimmed.length} chars, omitted-source=${summaryPrompt.includes('omitted for space')}`,
    );

    // Non-destructive: recorded only once the candidate is known to be better.
    conv.compaction = candidate;
    resetContextTrimState(conv);
    conv.updatedAt = Date.now();
    // Before invalidateExactTokenBudget below: that deletes the very counters
    // this row exists to preserve.
    const usedBefore = reportedContextTokens(conv);
    deps.logCompaction?.(conv, {
      generation,
      fromIndex,
      usedTokens: usedBefore,
      maxTokens: metrics?.max ?? 0,
      summaryChars: trimmed.length,
      summary: trimmed,
      trigger,
      ...(metrics?.threshold !== undefined ? { threshold: metrics.threshold } : {}),
    });
    deps.persistSession();
    deps.postSessionSync();
    deps.invalidateExactTokenBudget(conv);
    deps.postTokenBudget(conv);
    // The size at the cut, because nothing else can show it: the token bar has
    // just been reset to `0 / max` by invalidateExactTokenBudget above, so the
    // moment a compaction lands is the moment the number that triggered it
    // stops being visible anywhere. Both figures are exact — `usedBefore` is
    // the server's own count, read before the counters were cleared. Omitted
    // rather than guessed when the model has no configured window.
    const atSize =
      metrics && metrics.max > 0
        ? ` at ${usedBefore.toLocaleString()} / ${metrics.max.toLocaleString()}`
        : '';
    deps.post({
      type: 'notice',
      message: `Conversation compacted${atSize}. Chat history is unchanged.`,
      conversationId: conv.id,
    });
    if (!options.auto) {
      void vscode.window.showInformationMessage(
        'Forge: context compacted. Your chat history is unchanged.',
      );
    }
    outcome = 'compacted';
    deactivateLazyGroups(conversationId);
    return outcome;
  } catch (err) {
    const category =
      err instanceof PromptIncompleteError ? 'incomplete-output' : compactionFailureCategory(err);
    if (err instanceof PromptIncompleteError) attemptFinish = err.finishReason ?? 'none';
    options.onFailureCategory?.(category);
    deps.post({
      type: 'error',
      message: `Forge: compaction failed — ${(err as Error).message}`,
      conversationId: conv.id,
    });
    return 'failed';
  } finally {
    // Every started compaction has one terminal event, including failures while
    // applying or persisting an otherwise usable summary.
    logAttempt({
      phase: 'finished',
      outcome,
      ...(attemptCategory ? { category: attemptCategory } : {}),
      ...(attemptCalls !== undefined ? { calls: attemptCalls } : {}),
      ...(attemptFinish ? { finishReason: attemptFinish } : {}),
    });
    deps.emitCompactionEvent?.({
      conversationId: conv.id,
      phase: 'finished',
      outcome,
      trigger,
      ...(remoteOrigin ? { remoteOrigin } : {}),
    });
  }
}

export {
  RETAINED_TAIL_MAX_CHARS,
  selectCompactionSplit,
  type CompactionSplit,
} from './compactionSplit';
