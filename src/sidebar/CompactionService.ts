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
import { getLogger } from '../util/logger';

const log = getLogger();

export interface CompactionDeps {
  post: (msg: HostToWebview) => void;
  getActiveConv: () => ConversationRuntime;
  persistSession: () => void;
  postSessionSync: () => void;
  invalidateExactTokenBudget: () => void;
  postTokenBudget: () => void;
  runPromptToMarkdown: (text: string, conversationId?: string) => Promise<string>;
  isStreaming: () => boolean;
  /** Marks the conversation busy for the duration of the summarization call.
   *  Returns the release. */
  beginCompaction: (convId: string) => () => void;
}

export type CompactionOutcome = 'compacted' | 'skipped' | 'failed';

/** Cap on the verbatim tail kept out of the summary. One large tool dump must
 *  not be retained in full — that would defeat the compaction that just ran. */
export const RETAINED_TAIL_MAX_CHARS = 4000;

/** Messages that must remain on the summarized side of the cut. Below this the
 *  summary has nothing to say and compaction is not worth a request. */
const MIN_SUMMARIZED_MESSAGES = 2;

/** Prompt used to continue the active task after an auto-compaction. */
export const RESUME_PROMPT =
  'Context was compacted. Read the continuation checkpoint, continue from Next, and do not repeat completed work.';

/** Consecutive auto-resumes allowed without an intervening user prompt. */
export const MAX_CONSECUTIVE_AUTO_CONTINUES = 2;

function isSummarizable(m: ChatMessage): boolean {
  return (
    ((m.role === 'user' || m.role === 'tool') && typeof m.content === 'string') ||
    (m.role === 'assistant' && (typeof m.content === 'string' || Boolean(m.tool_calls?.length)))
  );
}

/** Cap a single tool result inside the summarization prompt. */
const TOOL_RESULT_MAX_CHARS = 2000;

export function truncateForSummary(text: string): string {
  return text.length <= TOOL_RESULT_MAX_CHARS
    ? text
    : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated for summary]`;
}

export interface CompactionSplit {
  /** Messages fed to the summarizer. */
  summarize: ChatMessage[];
  /** Index into `pending` where the retained verbatim tail begins. */
  tailStart: number;
}

/** Keep the continuation checkpoint small enough to be useful, not a second transcript. */
export const COMPACTION_SUMMARY_MAX_CHARS = 5000;

/** Bound the input to the summarization turn as well as its output. */
const SUMMARY_SOURCE_MAX_CHARS = 24000;
const PREVIOUS_SUMMARY_MAX_CHARS = COMPACTION_SUMMARY_MAX_CHARS;
const MESSAGE_TEXT_MAX_CHARS = 3000;
const TOOL_CALL_METADATA_MAX_CHARS = 1200;

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

function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function formatToolCalls(message: ChatMessage): string {
  if (!message.tool_calls?.length) return '';
  const details = message.tool_calls
    .map((call) => `${call.function.name}(${truncateText(call.function.arguments, 400)})`)
    .join(', ');
  return `\nTool calls: ${truncateText(details, TOOL_CALL_METADATA_MAX_CHARS)}`;
}

function formatSummaryMessage(message: ChatMessage): string {
  const content =
    typeof message.content === 'string'
      ? message.content
      : message.content === null
        ? '[no visible assistant text]'
        : '[non-text content]';
  const body =
    message.role === 'tool'
      ? truncateForSummary(content)
      : truncateText(content, MESSAGE_TEXT_MAX_CHARS);
  const reasoning = message.reasoning
    ? `\nReasoning note: ${truncateText(message.reasoning, 600)}`
    : '';
  return `${message.role.toUpperCase()}:\n${body}${formatToolCalls(message)}${reasoning}`;
}

function capSummarySource(source: string): string {
  if (source.length <= SUMMARY_SOURCE_MAX_CHARS) return source;
  const head = Math.floor(SUMMARY_SOURCE_MAX_CHARS * 0.35);
  const tail = SUMMARY_SOURCE_MAX_CHARS - head;
  return `${source.slice(0, head)}\n…[middle of compaction source omitted]…\n${source.slice(-tail)}`;
}

export function buildSummaryPrompt(
  previousSummary: string | undefined,
  messages: ChatMessage[],
): string {
  const previous = previousSummary
    ? `EARLIER CHECKPOINT:\n${truncateText(previousSummary, PREVIOUS_SUMMARY_MAX_CHARS)}\n\n`
    : '';
  const transcript = capSummarySource(messages.map(formatSummaryMessage).join('\n\n'));
  return (
    'Create a compact continuation checkpoint for the same repository.\n\n' +
    'Use only facts present below. Keep it under 600 words and omit empty sections. ' +
    'Use these labels: Goal, State, Next, Files, Constraints, Errors. ' +
    'Record the exact next action when one is clear; do not retell the conversation.\n\n' +
    `${previous}Conversation:\n${transcript}`
  );
}

function capSummary(summary: string): string {
  return truncateText(summary.trim(), COMPACTION_SUMMARY_MAX_CHARS);
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
  try {
    summary = await deps.runPromptToMarkdown(
      buildSummaryPrompt(conv.compaction?.summary, split.summarize),
      conv.id,
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
  if (!trimmed) {
    void vscode.window.showWarningMessage('Forge: compaction returned no summary.');
    return 'failed';
  }

  // Non-destructive: record the summary and the cut point instead of
  // overwriting the transcript. conv.messages stays whole, so the sidebar
  // scrollback and the persisted record survive; only what the model is sent
  // shrinks (see applyCompactionWindow).
  conv.compaction = { summary: trimmed, fromIndex };
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
  send: (text: string) => Promise<void>;
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
    await deps.send(RESUME_PROMPT);
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
