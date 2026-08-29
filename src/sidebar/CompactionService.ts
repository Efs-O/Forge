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
import {
  buildSummaryPrompt,
  capSummary,
  isUsableSummary,
  SUMMARY_OUTPUT_TOKENS,
} from './compactionPrompt';
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
import { selectCompactionSplit } from './compactionSplit';

const log = getLogger();

export interface CompactionDeps {
  post: (msg: HostToWebview) => void;
  getConversation: (conversationId: string) => ConversationRuntime | undefined;
  persistSession: () => void;
  postSessionSync: () => void;
  invalidateExactTokenBudget: (conv: ConversationRuntime) => void;
  postTokenBudget: (conv: ConversationRuntime) => void;
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
}

export type CompactionOutcome = 'compacted' | 'skipped' | 'failed';

/**
 * Prompt used to continue the active task after a compaction. Every noun must
 * name something already in the model's window, in that window's own words:
 * "Read the continuation checkpoint" sent agents hunting for a file, because
 * the phrase lived only in `buildSummaryPrompt` (a request they never see)
 * while what they DO see says "Conversation summary" — and "checkpoint" is
 * Forge's Keep/Undo system while "Read" is the `read_file` verb.
 *
 * Third instance, 2026-08-22: "Continue the task from its Next section" pointed
 * at a section `buildSummaryPrompt` had told the model to omit when empty. The
 * task was finished, the summary correctly carried no Next, and the resumed
 * agent burned a turn hunting for it. `buildSummaryPrompt` now always emits
 * Next, and this prompt no longer assumes what that section says.
 *
 * Fourth instance, 2026-08-27: increasingly forceful resume wording still
 * drifted because the missing state was structural, not instructional. The
 * replacement context now carries user intent and host facts independently,
 * so this is deliberately only a neutral protocol trigger. Chat Completions
 * still needs a user-role input to begin another response; no task state is
 * entrusted to that input.
 */
export const RESUME_PROMPT = 'Continue the active task from the compacted context.';

/** Consecutive auto-resumes allowed without an intervening user prompt. */
export const MAX_CONSECUTIVE_AUTO_CONTINUES = 2;

/**
 * Runs one compaction against the active conversation.
 *
 * `auto` only changes the messaging: an automatic compaction the user did not
 * ask for should not pop modal-ish information toasts.
 */
export async function runCompaction(
  deps: CompactionDeps,
  conversationId: string,
  options: { auto: boolean } = { auto: false },
): Promise<CompactionOutcome> {
  if (deps.isStreaming(conversationId)) {
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
  const split = selectCompactionSplit(conv.messages.slice(from));
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
  const recordedActions = mergeRecordedActions(conv.compaction?.recordedActions, currentActions);
  const recordedActionsText = renderRecordedActionsBlock(recordedActions);
  const userMessages = collectCompactionUserMessages(
    conv.compaction?.userMessages,
    split.summarize,
  );
  const userContext = renderCompactionUserMessages(userMessages);

  deps.post({ type: 'notice', message: 'Compacting conversation…', conversationId: conv.id });
  // The webview treats the conversation as streaming between these two, so a
  // prompt typed during the summarization is queued and flushed after it rather
  // than racing the cut point.
  deps.post({ type: 'generationStarted', conversationId: conv.id });
  const release = deps.beginCompaction(conv.id);
  let summary: string;
  let repoState = '';
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
    // Supply the deterministic ledger to the summarizer as well as pinning it
    // below. A long tool dump used to hide an already-completed download from
    // the model that wrote the summary, leaving only an earlier "next" step.
    summary = await deps.runPromptToMarkdown(
      buildSummaryPrompt(
        conv.compaction?.summary,
        split.summarize,
        recordedActionsText + repoState,
        userContext,
      ),
      conv.id,
      {
        // The conversation's OWN model, not the picker's global default: a
        // pinned conversation was being summarized by whatever was last
        // selected elsewhere.
        ...(conv.active_model ? { modelName: conv.active_model } : {}),
        systemPromptTemplate: 'summarize',
        outputTokens: SUMMARY_OUTPUT_TOKENS,
        alwaysStripThinking: true,
      },
    );
  } catch (err) {
    deps.post({
      type: 'error',
      message: `Forge: compaction failed — ${(err as Error).message}`,
      conversationId: conv.id,
    });
    return 'failed';
  } finally {
    release();
    deps.post({ type: 'done', finishReason: 'stop', conversationId: conv.id });
  }

  const trimmed = capSummary(summary);
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
  conv.compaction = {
    summary: trimmed,
    fromIndex,
    generation: (conv.compaction?.generation ?? 0) + 1,
    ...(userMessages.length > 0 ? { userMessages } : {}),
    ...(recordedActions.length > 0 ? { recordedActions } : {}),
    ...(repoState ? { repoState } : {}),
  };
  conv.updatedAt = Date.now();
  deps.persistSession();
  deps.postSessionSync();
  deps.invalidateExactTokenBudget(conv);
  deps.postTokenBudget(conv);
  deps.post({
    type: 'notice',
    message: 'Conversation compacted. Chat history is unchanged.',
    conversationId: conv.id,
  });
  if (!options.auto) {
    void vscode.window.showInformationMessage(
      'Forge: context compacted. Your chat history is unchanged.',
    );
  }
  return 'compacted';
}

export {
  RETAINED_TAIL_MAX_CHARS,
  selectCompactionSplit,
  type CompactionSplit,
} from './compactionSplit';
