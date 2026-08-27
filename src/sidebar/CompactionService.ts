/**
 * Compaction execution: turning a conversation into a summary + verbatim tail.
 *
 * Sole owner of *how* a compaction is produced. `compactionWindow.ts` owns how
 * the recorded result is applied at request time; this file owns choosing the
 * cut point, building the summarization prompt, and running it.
 */

import * as vscode from 'vscode';
import type { ChatMessage } from '../llm/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import {
  buildSummaryPrompt,
  capSummary,
  isUsableSummary,
  SUMMARY_OUTPUT_TOKENS,
} from './compactionPrompt';
import { recordedActionsBlock } from './compactionLedger';
import type { PromptRunOptions } from './PromptRun';
import { getLogger } from '../util/logger';
import type { UserPromptOptions } from './transcriptMutations';

const log = getLogger();

export interface CompactionDeps {
  post: (msg: HostToWebview) => void;
  getActiveConv: () => ConversationRuntime;
  persistSession: () => void;
  postSessionSync: () => void;
  invalidateExactTokenBudget: () => void;
  postTokenBudget: () => void;
  runPromptToMarkdown: (
    text: string,
    conversationId?: string,
    options?: PromptRunOptions,
  ) => Promise<string>;
  isStreaming: () => boolean;
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

/** Cap on the verbatim tail kept out of the summary. One large tool dump must
 *  not be retained in full — that would defeat the compaction that just ran. */
export const RETAINED_TAIL_MAX_CHARS = 4000;

/** Messages that must remain on the summarized side of the cut. Below this the
 *  summary has nothing to say and compaction is not worth a request. */
const MIN_SUMMARIZED_MESSAGES = 2;

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
 * Fourth instance, 2026-08-27: "do not redo work it records as done" is a
 * prohibition a model violates the moment it feels uncertain, and prose it
 * cannot verify makes it uncertain constantly. The wording now points at the
 * host-recorded blocks `compactionLedger.ts` appends and permits exactly the
 * verification those blocks cannot supply. This is guidance, not enforcement —
 * nothing here stops a model re-reading a file, and the fix for that is
 * removing the REASON to re-read, not scolding it harder.
 */
export const RESUME_PROMPT =
  'Context was compacted. The conversation summary above is your working context - nothing else is being withheld. ' +
  'The blocks marked "recorded by Forge" are host-recorded outcomes, not model claims: prefer them over re-checking. ' +
  'A successful command with named output evidence means that artifact or state was already observed; do not repeat its download or installation unless the user asks or an entry is marked FAILED or unknown. ' +
  'Do what the Next section of that summary records. If Next says the task is complete, report that to the user instead of starting new work.';

/** Consecutive auto-resumes allowed without an intervening user prompt. */
export const MAX_CONSECUTIVE_AUTO_CONTINUES = 2;

function isSummarizable(m: ChatMessage): boolean {
  return (
    ((m.role === 'user' || m.role === 'tool') && typeof m.content === 'string') ||
    (m.role === 'assistant' && (typeof m.content === 'string' || Boolean(m.tool_calls?.length)))
  );
}

export interface CompactionSplit {
  /** Messages fed to the summarizer. */
  summarize: ChatMessage[];
  /** Index into `pending` where the retained verbatim tail begins. */
  tailStart: number;
}

/**
 * Splits the still-uncompacted messages into "summarize this" and "keep this
 * verbatim".
 *
 * The tail is the last user message and everything after it, so the model keeps
 * one concrete exchange instead of a paraphrase alone. It is bounded by
 * `RETAINED_TAIL_MAX_CHARS` and by leaving `MIN_SUMMARIZED_MESSAGES` behind, so
 * a single huge exchange cannot swallow the whole window.
 */
export function selectCompactionSplit(pending: ChatMessage[]): CompactionSplit | null {
  const summarizable = pending.filter(isSummarizable);
  if (summarizable.length < MIN_SUMMARIZED_MESSAGES) return null;

  let tailStart = pending.length;
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i]?.role !== 'user') continue;
    const candidate = pending.slice(i);
    const chars = candidate.reduce(
      (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );
    if (chars > RETAINED_TAIL_MAX_CHARS) break;
    // Never retain so much that the summary side falls under the minimum —
    // otherwise a short chat "compacts" into a copy of itself.
    if (pending.slice(0, i).filter(isSummarizable).length < MIN_SUMMARIZED_MESSAGES) break;
    tailStart = i;
    break;
  }

  return { summarize: pending.slice(0, tailStart).filter(isSummarizable), tailStart };
}

/**
 * Runs one compaction against the active conversation.
 *
 * `auto` only changes the messaging: an automatic compaction the user did not
 * ask for should not pop modal-ish information toasts.
 */
export async function runCompaction(
  deps: CompactionDeps,
  options: { auto: boolean } = { auto: false },
): Promise<CompactionOutcome> {
  if (deps.isStreaming()) {
    void vscode.window.showInformationMessage(
      'Forge: wait for the current response to finish before compacting.',
    );
    return 'skipped';
  }
  const conv = deps.getActiveConv();
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
    const recordedActions = recordedActionsBlock(split.summarize);
    summary = await deps.runPromptToMarkdown(
      buildSummaryPrompt(conv.compaction?.summary, split.summarize, recordedActions),
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

  // Recorded by code from the tool calls, so what the agent did survives even
  // when the source cap kept it out of the summarizer's view — and so a failed
  // write is never reported as a completed one.
  const recorded = recordedActionsBlock(split.summarize) + repoState;
  const trimmed = capSummary(summary, recorded.length);
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
  conv.compaction = { summary: `${trimmed}${recorded}`, fromIndex };
  conv.updatedAt = Date.now();
  deps.persistSession();
  deps.postSessionSync();
  deps.invalidateExactTokenBudget();
  deps.postTokenBudget();
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

export interface AutoCompactDeps {
  convId: string;
  post: (msg: HostToWebview) => void;
  compact: (options: { auto: boolean }) => Promise<CompactionOutcome>;
  /** Why the last turn stopped short, or undefined if it finished. */
  incompleteTurnReason: () => string | undefined;
  resumeEnabled: boolean;
  autoContinues: () => number;
  noteAutoContinue: () => void;
  send: (text: string, options?: UserPromptOptions) => Promise<void>;
}

export type CompactionResumeDeps = Pick<
  AutoCompactDeps,
  | 'convId'
  | 'post'
  | 'incompleteTurnReason'
  | 'resumeEnabled'
  | 'autoContinues'
  | 'noteAutoContinue'
  | 'send'
>;

/** Continue the conversation after a successful compaction. */
export async function resumeAfterCompaction(
  deps: CompactionResumeDeps,
  options: { automatic: boolean; reason?: string } = { automatic: true },
): Promise<void> {
  const reason = options.reason ?? deps.incompleteTurnReason();
  if (!deps.resumeEnabled) return;
  if (deps.autoContinues() >= MAX_CONSECUTIVE_AUTO_CONTINUES) {
    if (!options.automatic) {
      // An explicit /compact is a deliberate user action and starts a fresh
      // continuation; the automatic-chain guard must not block it.
      log.info('[manual-compact] continuing after explicit compaction');
    } else {
      log.info('[auto-compact] resume limit reached — waiting for the user');
      deps.post({
        type: 'notice',
        message:
          'Forge: compacted again without finishing. Stopping here so this does not loop — send a prompt to continue.',
        conversationId: deps.convId,
      });
      return;
    }
  }

  if (options.automatic) deps.noteAutoContinue();
  // Re-arm the webview's streaming state before the resume turn.
  //
  // The webview sets `streaming` from its own USER_SEND (a click on Send) or
  // from a host `generationStarted`. `compact()` posts `done` in its finally,
  // which clears it — and this resume is host-initiated, so it never produces a
  // USER_SEND. Without this the resumed turn generated with `streaming: false`:
  // the Stop button vanished and only Send was left, with no way to cancel a
  // turn that was still running.
  deps.post({ type: 'generationStarted', conversationId: deps.convId });
  log.info(
    options.automatic
      ? reason
        ? `[auto-compact] resuming: ${reason}`
        : '[auto-compact] continuing after successful compaction'
      : '[manual-compact] continuing after successful compaction',
  );
  deps.post({
    type: 'notice',
    message: reason
      ? `Context compacted mid-task (${reason}). Resuming.`
      : 'Context compacted. Continuing the active task.',
    conversationId: deps.convId,
  });
  try {
    await deps.send(RESUME_PROMPT, { internal: true });
  } catch (err) {
    deps.post({
      type: 'error',
      message: `Forge: could not resume after compaction — ${(err as Error).message}`,
      conversationId: deps.convId,
    });
  }
}

/** Run threshold compaction and, when enabled, resume the active conversation. */
export async function autoCompactAndResume(deps: AutoCompactDeps): Promise<void> {
  // Read before compacting: the summarization call itself must not determine
  // the status shown for the turn it interrupted.
  const reason = deps.incompleteTurnReason();
  const outcome = await deps.compact({ auto: true });
  if (outcome !== 'compacted') return;

  await resumeAfterCompaction(deps, {
    automatic: true,
    ...(reason !== undefined ? { reason } : {}),
  });
}
