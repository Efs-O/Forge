/**
 * Compaction execution: turning a conversation into a summary + verbatim tail.
 *
 * Sole owner of *how* a compaction is produced. `compactionWindow.ts` owns how
 * the recorded result is applied at request time; this file owns choosing the
 * cut point, building the summarization prompt, and running it.
 */

import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import { buildSummaryPrompt, capSummary, isUsableSummary } from './compactionPrompt';
import {
  COMPACTION_CHARS_PER_TOKEN,
  COMPACTION_REQUEST_OUTPUT_TOKENS,
  compactionBudget,
  fitSummaryPrompt,
} from './compactionBudget';
import {
  collectRecordedActions,
  mergeRecordedActions,
  renderRecordedActionsBlock,
} from './compactionLedger';
import {
  collectCompactionUserMessages,
  renderCompactionUserMessages,
} from './compactionUserContext';
import type { PromptRunOptions } from './PromptRun';
import { getLogger } from '../util/logger';
import { collectLastReply, toolActivityFollowedLastReply } from './compactionLastReply';
import { selectCompactionSplit } from './compactionSplit';
import type { CompactionLogEntry } from './SessionLogger';
import { reportedContextTokens } from '../util/contextBudget';
import { boundMemoryKeys, compactionWindowChars, messageCostChars } from './compactionWindow';
import type { CompactionState } from './compactionTypes';
import { deactivateLazyGroups, lazyGroupSummaryNote } from '../tools/lazyToolGroups';
import { resetContextTrimState } from '../agent/toolResultContext';

const log = getLogger();

export interface CompactionDeps {
  post: (msg: HostToWebview) => void;
  getConversation: (conversationId: string) => ConversationRuntime | undefined;
  persistSession: () => void;
  postSessionSync: () => void;
  invalidateExactTokenBudget: (conv: ConversationRuntime) => void;
  postTokenBudget: (conv: ConversationRuntime) => void;
  /**
   * Records the completed compaction on the session transcript.
   *
   * Optional: sidebar-only callers and tests omit it, and a compaction must
   * never fail because nothing is listening. `usedTokens` has to be read before
   * `invalidateExactTokenBudget` clears the counters, so the reading happens at
   * the call site rather than inside the sink.
   */
  logCompaction?: (conv: ConversationRuntime, entry: CompactionLogEntry) => void;
  /** Per-slot window and the configured auto-compaction threshold, for the log row. */
  compactionMetrics?: (conv: ConversationRuntime) => {
    max: number;
    threshold?: number;
    reasoningReserve?: number;
  };
  runPromptToMarkdown: (
    text: string,
    conversationId?: string,
    options?: PromptRunOptions,
  ) => Promise<string>;
  isStreaming: (conversationId: string) => boolean;
  /** Marks the conversation busy for the duration of the summarization call.
   *  Returns the release. */
  beginCompaction: (convId: string) => () => void;
  /**
   * Working-tree state to append to the summary, so a resumed agent can check
   * the recorded ledger against the repo without spending a tool call.
   *
   * Injected rather than imported so the git/process dependency stays out of
   * this file's tests, and optional so a caller that cannot supply one still
   * compacts — the block is evidence, never a precondition.
   */
  snapshotRepoState?: () => Promise<string>;
  /** Keys stored with `remember`, listed after the cut so `recall` has one to ask for. */
  listMemoryKeys?: () => readonly string[];
  /**
   * Host-originated compaction progress, consumed by the remote layer so a
   * Telegram/WhatsApp user sees "compacting…" for work they did not start.
   * Optional: sidebar-only callers (and tests) omit it.
   */
  emitCompactionEvent?: (event: CompactionEvent) => void;
}

export type CompactionTrigger = 'auto' | 'sidebar' | 'remote';

export interface CompactionEvent {
  conversationId: string;
  phase: 'started' | 'finished';
  /** Set on 'finished' only — the true terminal outcome. */
  outcome?: CompactionOutcome;
  /** Which path started this compaction; drives remote delivery policy. */
  trigger: CompactionTrigger;
  /** Set when trigger === 'remote' so the origin chat is identifiable. */
  remoteOrigin?: { channel: string; chatId: string };
}

export type CompactionOutcome = 'compacted' | 'skipped' | 'failed';

/** Neutral user-role trigger. Task state lives in the replacement context;
 * references to a "checkpoint" or a possibly absent section caused prior
 * agents to hunt for nonexistent state after compaction. */
export const RESUME_PROMPT = 'Continue the active task from the compacted context.';

/** Consecutive auto-resumes allowed without an intervening user prompt. */
export const MAX_CONSECUTIVE_AUTO_CONTINUES = 2;

/** Small manual compactions may grow; only a substantial window risks a loop. */
export const MIN_WINDOW_CHARS_FOR_FIT_GUARD = 24000;

/** The one wording for a refused compaction, whichever check refused it. */
function refusalNotice(afterChars: number, beforeChars: number): string {
  return (
    'Forge: compaction would not have reduced the context ' +
    `(estimated ~${afterChars.toLocaleString()} vs ~${beforeChars.toLocaleString()} characters), ` +
    'so the previous state was kept. Start a new chat, or remove large attachments, if this repeats.'
  );
}

/**
 * The conversation's user-message count at its last failed AUTOMATIC compaction.
 *
 * A failure that is caused by config (an output budget too small for the
 * model's thinking, a window no summary can shrink) repeats identically, and
 * both triggers re-fire on every check: mid-turn every round, then post-turn
 * as soon as the turn ends. On 2026-09-22 that was seven summarizations in two
 * minutes, each one a warning and a paid cloud call. After a failure, automatic
 * compaction waits for the user's next message; /compact is never held back.
 */
const failedAutoAt = new WeakMap<ConversationRuntime, number>();

function userMessageCount(conv: ConversationRuntime): number {
  return conv.messages.filter((m) => m.role === 'user' && m.internal !== true).length;
}

/**
 * Runs one compaction against the active conversation.
 *
 * `auto` changes the messaging (an automatic compaction the user did not ask
 * for should not pop modal-ish information toasts) and applies the
 * retry-after-failure hold described at `failedAutoAt`.
 */
export async function runCompaction(
  deps: CompactionDeps,
  conversationId: string,
  options: CompactionOptions = { auto: false },
): Promise<CompactionOutcome> {
  const conv = deps.getConversation(conversationId);
  if (!options.auto || !conv) return compactOnce(deps, conversationId, options);
  const at = userMessageCount(conv);
  if (failedAutoAt.get(conv) === at) {
    log.info('[auto-compact] skipped — the last attempt failed and no new user message since');
    return 'skipped';
  }
  let outcome: CompactionOutcome = 'failed';
  try {
    outcome = await compactOnce(deps, conversationId, options);
    return outcome;
  } finally {
    if (outcome === 'failed') failedAutoAt.set(conv, at);
    else failedAutoAt.delete(conv);
  }
}

interface CompactionOptions {
  auto: boolean;
  trigger?: CompactionTrigger;
  remoteOrigin?: { channel: string; chatId: string };
  /**
   * Called by the tool loop between two rounds of a turn that is still
   * running. The turn owns the streaming state, so this skips the streaming
   * guard, `beginCompaction` (whose release would clear the TURN's streaming
   * flag) and the generationStarted/done posts (which would end its bubble).
   */
  midTurn?: boolean;
}

async function compactOnce(
  deps: CompactionDeps,
  conversationId: string,
  options: CompactionOptions,
): Promise<CompactionOutcome> {
  const trigger: CompactionTrigger = options.trigger ?? 'sidebar';
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
  const lastReply = collectLastReply(pending.slice(split.tailStart))
    ? undefined
    : collectLastReply(split.summarize);
  // Recorded with the reply, because the transcript it was derived from is not
  // available when the block is rendered on a later turn. The retained tail
  // counts too: a tail of tool calls with no text of its own ran after the reply.
  const lastReplyFollowedByTools = lastReply
    ? toolActivityFollowedLastReply([...split.summarize, ...pending.slice(split.tailStart)])
    : false;

  const memoryKeys = boundMemoryKeys(deps.listMemoryKeys?.() ?? []);

  // Everything the candidate state will carry except the summary itself. Built
  // here so the floor check below can run BEFORE the summarization request.
  const candidateWithSummary = (summaryText: string): CompactionState => ({
    summary: summaryText,
    fromIndex,
    generation: (conv.compaction?.generation ?? 0) + 1,
    ...(userMessages.length > 0 ? { userMessages } : {}),
    ...(recordedActions.length > 0 ? { recordedActions } : {}),
    ...(omittedActions.file > 0 || omittedActions.command > 0 ? { omittedActions } : {}),
    ...(repoState ? { repoState } : {}),
    ...(memoryKeys.length > 0 ? { memoryKeys } : {}),
    ...(lastReply ? { lastReply } : {}),
    ...(lastReply && lastReplyFollowedByTools ? { lastReplyFollowedByTools } : {}),
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
  let summary = '';
  let summaryPrompt = '';
  let repoState = '';
  let outcome: CompactionOutcome = 'failed';
  try {
    try {
      // Keep the conversation busy while the bounded snapshot runs. Awaiting it
      // before beginCompaction left a window in which a new turn could start and
      // invalidate the cut point we just selected.
      if (deps.snapshotRepoState) {
        try {
          repoState = await deps.snapshotRepoState();
        } catch (err) {
          // Evidence is optional even when an injected implementation is faulty.
          // The real snapshotter already catches its own git errors; this guard
          // preserves CompactionDeps' promise that it can never block compaction.
          log.info(`[compact] repo snapshot unavailable — ${(err as Error).message}`);
        }
      }
      // If even an empty summary cannot shrink this window, skip the model call.
      const floorChars = compactionWindowChars(conv.messages, candidateWithSummary(''));
      const tailChars = pending
        .slice(split.tailStart)
        .reduce((sum, message) => sum + messageCostChars(message), 0);
      const hostChars = floorChars - tailChars;
      if (hostChars > budget.hostMaxChars) {
        throw new Error(
          `Host-preserved compaction facts need an estimated ${hostChars} characters, above the ${budget.hostMaxChars}-character budget; previous context kept.`,
        );
      }
      if (beforeChars >= MIN_WINDOW_CHARS_FOR_FIT_GUARD && floorChars >= beforeChars) {
        log.info(
          `[compact] no summary could shrink this window (~${floorChars} vs ~${beforeChars} chars before the summary) — not summarizing`,
        );
        deps.post({
          type: 'notice',
          message: refusalNotice(floorChars, beforeChars),
          conversationId: conv.id,
        });
        return 'failed';
      }

      // Supply the deterministic ledger to the summarizer as well as pinning it
      // below. A long tool dump used to hide an already-completed download from
      // the model that wrote the summary, leaving only an earlier "next" step.
      const fit = fitSummaryPrompt(
        budget,
        modelMax,
        (sourceMaxChars) =>
          buildSummaryPrompt(
            conv.compaction?.summary,
            split.summarize,
            recordedActionsText + repoState,
            userContext,
            // The agent's own plan, which the summarization request did not carry
            // before. Supplied as intent, not evidence — see planSnapshotBlock.
            conv.plan?.items,
            { ...budget, sourceMaxChars },
          ),
        thinkingTokens,
      );
      summaryPrompt = fit.prompt;
      log.info(
        `[compact] budget P=${budget.policyTokens} (${budget.estimated ? 'estimated' : 'reported'}), source~${fit.estimatedTokens} tokens, host~${Math.ceil(hostChars / COMPACTION_CHARS_PER_TOKEN)}, tail~${Math.ceil(tailChars / COMPACTION_CHARS_PER_TOKEN)}, output_cap=${COMPACTION_REQUEST_OUTPUT_TOKENS}, summary_target=${budget.summaryTargetTokens}`,
      );
      summary = await deps.runPromptToMarkdown(summaryPrompt, conv.id, {
        // The conversation's OWN model, not the picker's global default: a
        // pinned conversation was being summarized by whatever was last
        // selected elsewhere.
        ...(conv.active_model ? { modelName: conv.active_model } : {}),
        systemPromptTemplate: 'summarize',
        outputTokens: COMPACTION_REQUEST_OUTPUT_TOKENS,
        strictOutputTokens: true,
        alwaysStripThinking: true,
      });
    } finally {
      release();
      if (!midTurn) deps.post({ type: 'done', finishReason: 'stop', conversationId: conv.id });
    }

    const groupsNote = lazyGroupSummaryNote(conversationId);
    const proposed = groupsNote ? `${summary.trim()}\n\n${groupsNote}` : summary.trim();
    if (proposed.length > budget.summaryCeilingChars) {
      throw new Error(
        `Summary exceeds the estimated ${budget.summaryCeilingChars}-character ceiling; previous context kept.`,
      );
    }
    const trimmed = capSummary(proposed, budget.summaryCeilingChars);
    if (!isUsableSummary(trimmed)) {
      log.info(`[compact] rejected unusable summary (${trimmed.length} chars)`);
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
      throw new Error(
        `Replacement context needs an estimated ${afterChars} characters, above its ${budget.replacementMaxChars}-character budget; previous context kept.`,
      );
    }
    if (beforeChars >= MIN_WINDOW_CHARS_FOR_FIT_GUARD && afterChars >= beforeChars) {
      log.info(
        `[compact] candidate window is not smaller (~${afterChars} vs ~${beforeChars} chars) — keeping the previous state`,
      );
      deps.post({
        type: 'notice',
        message: refusalNotice(afterChars, beforeChars),
        conversationId: conv.id,
      });
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
    const metrics = deps.compactionMetrics?.(conv);
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
    deps.post({
      type: 'error',
      message: `Forge: compaction failed — ${(err as Error).message}`,
      conversationId: conv.id,
    });
    return 'failed';
  } finally {
    // Every started compaction has one terminal event, including failures while
    // applying or persisting an otherwise usable summary.
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
