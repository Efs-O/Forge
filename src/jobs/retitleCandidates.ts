/**
 * Which chats the daily retitle job may rename (proposal 1 of
 * `docs/plans/NEXT_WEEK_PROPOSALS_2026_10_24_PLAN.md`, decided in
 * `docs/plans/V1_FINISH_PLAN.md`).
 *
 * Everything here is pure: a chat is a record, not a live sidebar object, so the
 * filter — the part that decides whether a name survives — is testable with
 * plain objects, including records written before `title_source` existed.
 * `src/jobs/retitleRun.ts` reads the records off disk and applies the result;
 * nothing in this file knows about files, VS Code or the model.
 *
 * The rule the whole feature turns on: a chat is only worth naming automatically
 * while it still carries the name its first prompt gave it. Once a person has
 * typed a name, or the job has proposed one, that chat is theirs for good.
 */

import { isUntitled, titleSourceOf } from '../sidebar/conversationTitle';
import { JOB_TASK_PROMPT_MARKER } from './agentTaskPrompt';

/** The first line every scheduled job turn begins with (`agentTaskPrompt.ts`).
 *  Durable job evidence: `JobStore.delete` removes a job and the conversation id
 *  in its state with it, but the chat and its first line stay (`ArchivedSessions`
 *  research, 2026-10-24). Re-exported here so this module's tests read the rule
 *  from the filter that uses it. */
export { JOB_TASK_PROMPT_MARKER };

/** One chat, as the scan sees it: enough to decide, not the whole transcript. */
export interface RetitleConversation {
  id: string;
  title: string;
  /** Absent on records written before the field existed; then `firstUserLine`
   *  decides, the way `titleSourceOf` says. */
  titleSource?: 'prompt' | 'user' | 'auto';
  /** The first user line, when it is on disk. Without it a title of unknown
   *  origin counts as the owner's, and a chat with nothing to name it from is
   *  skipped anyway. */
  firstUserLine?: string;
  /** A line of the last assistant answer, when it is on disk: the other half of
   *  what the model is asked to name the chat from. */
  lastAssistantLine?: string;
  updatedAt: number;
  /** True when a body for this chat sits in `open/`: the window may be using it. */
  open: boolean;
  /** True while a turn is streaming in it. */
  streaming?: boolean;
}

export interface RetitleFilterOptions {
  /** Epoch ms of the run. */
  now: number;
  /** A chat updated less than this ago is skipped: the owner may still be in it. */
  minIdleMs: number;
  /** Titles proposed at most per run, so one job cannot rewrite the history list. */
  limit: number;
  /** Conversation ids the jobs own (`JobStore` state), which must never be retitled. */
  jobConversationIds: ReadonlySet<string>;
  /** The retitle job's own chat, when it has one: naming itself would loop. */
  ownConversationIds?: ReadonlySet<string>;
}

/** A chat that passed the filter, with the text the title will be asked from. */
export interface RetitleCandidate {
  id: string;
  title: string;
  firstUserLine: string;
  lastAssistantLine?: string;
  updatedAt: number;
}

/** Why a chat was not offered. `ok` means it is a candidate. */
export type RetitleSkipReason =
  | 'ok'
  | 'named-by-a-person'
  | 'already-auto-named'
  | 'job-chat'
  | 'open-or-streaming'
  | 'too-recent'
  | 'nothing-to-name-it-from';

/** Why this chat is or is not on the list. Exported so a test can name the rule
 *  that fired instead of only asserting the chat is absent. */
export function retitleSkipReason(
  record: RetitleConversation,
  options: RetitleFilterOptions,
): RetitleSkipReason {
  if (options.jobConversationIds.has(record.id)) return 'job-chat';
  if (options.ownConversationIds?.has(record.id)) return 'job-chat';
  // A job's chat is recognizable even after the job was deleted, because the
  // first line of every scheduled turn names the job (`agentTaskPrompt.ts`).
  if (record.firstUserLine?.startsWith(JOB_TASK_PROMPT_MARKER)) return 'job-chat';
  // A placeholder is the name a prompt gave (or failed to give), so it is fair
  // game even when its origin cannot be read — a log-sourced archive row has no body.
  if (!isUntitled(record.title)) {
    const source = titleSourceOf(
      { title_source: record.titleSource, title: record.title },
      record.firstUserLine,
    );
    if (source === 'user') return 'named-by-a-person';
    if (source === 'auto') return 'already-auto-named';
  }
  if (record.open || record.streaming) return 'open-or-streaming';
  if (options.now - record.updatedAt < options.minIdleMs) return 'too-recent';
  // The title is asked from the first prompt and the last answer; with no first
  // line there is nothing to ask about, and a made-up name is worse than the
  // half-sentence the chat already has.
  if (!record.firstUserLine?.trim()) return 'nothing-to-name-it-from';
  return 'ok';
}

/**
 * The chats to offer, oldest first.
 *
 * Oldest first because the batch limit is real: with 150 chats carrying
 * half-sentence names and a limit of 20, the run should make progress on the
 * chats that have waited longest, not on whichever id sorts first.
 */
export function pickRetitleCandidates(
  records: readonly RetitleConversation[],
  options: RetitleFilterOptions,
): RetitleCandidate[] {
  const chosen: RetitleCandidate[] = [];
  for (const record of [...records].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (chosen.length >= options.limit) break;
    if (retitleSkipReason(record, options) !== 'ok') continue;
    chosen.push({
      id: record.id,
      title: record.title,
      firstUserLine: record.firstUserLine!.trim(),
      ...(record.lastAssistantLine?.trim()
        ? { lastAssistantLine: record.lastAssistantLine.trim() }
        : {}),
      updatedAt: record.updatedAt,
    });
  }
  return chosen;
}

/**
 * The request for one title. Kept here so the shape of the question is a
 * decision of this module, not of the runner, and so a test can read it.
 *
 * The input is capped hard (a few thousand characters, as the proposal
 * specified): the job runs on the chat model, and pasting a whole transcript
 * to name a chat would cost more than the title is worth.
 */
export const RETITLE_INPUT_CAP_CHARS = 4000;

export function buildRetitleRequest(candidate: RetitleCandidate): string {
  const clip = (value: string): string =>
    value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
  const first = clip(candidate.firstUserLine).replaceAll('<', '&lt;');
  const last = candidate.lastAssistantLine
    ? clip(candidate.lastAssistantLine).replaceAll('<', '&lt;')
    : '(no answer recorded)';
  return [
    'You are naming one saved chat in Forge. Reply with ONLY the new name: three to',
    'seven words, no quotes, no sentence, no trailing punctuation.',
    '',
    `The chat is currently called: ${clip(candidate.title).replaceAll('<', '&lt;')}`,
    `It began with: ${first}`,
    `Its last recorded answer began: ${last}`,
    '',
    'Say what the chat was for, in words a person would search for later. Do not',
    'invent a detail that is not in the two lines above.',
    `Input capped at ${RETITLE_INPUT_CAP_CHARS} characters per chat.`,
  ].join('\n');
}

/**
 * What the model sent back, cleaned into a title, or undefined when it is not
 * usable. A title longer than `deriveTitle`'s cap would be cut by the rename
 * path anyway, so a long rambling answer is refused here rather than half-kept.
 */
export function parseProposedTitle(answer: string, capUnits: number): string | undefined {
  const line = answer
    .split('\n')
    .map((candidate) => candidate.trim().replace(/^["'`]+|["'`]+$/g, ''))
    .find((candidate) => candidate.length > 0);
  if (!line) return undefined;
  // A model asked for a name sometimes answers in sentences; that is a failure
  // to follow the instruction, not a title to trim and hope about.
  if (line.length > capUnits) return undefined;
  if (/\s[.!?]$|[.!?]$/.test(line)) return undefined;
  if (isUntitled(line)) return undefined;
  return line;
}
