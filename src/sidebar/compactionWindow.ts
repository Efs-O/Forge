/**
 * Compaction window: turns a full transcript into the slice the model sees.
 *
 * `/compact` records a summary plus a cut point instead of overwriting the
 * conversation, so the sidebar transcript and the persisted record stay whole.
 * This applies that record at request time.
 */

import type { ChatMessage } from '../llm/types';
import { renderLastReplyBlock } from './compactionLastReply';
import { renderRecordedActionsBlock } from './compactionRecordedState';
import { renderCompactionUserMessages } from './compactionUserContext';
import {
  COMPACTION_MEMORY_KEY_MAX_CHARS,
  COMPACTION_MEMORY_KEYS_MAX,
  type CompactionState,
} from './compactionTypes';

/**
 * Where the resume guidance lives.
 *
 * Not in `RESUME_PROMPT`: that is a neutral protocol trigger, and forceful
 * wording there drifted because the missing state was structural. This text sits
 * beside the state it talks about.
 *
 * Deliberately not a blanket "trust everything": the ledger distinguishes `ok`,
 * `failed` and `unknown` precisely so an agent can check the doubtful thing and
 * only that. It also does not forbid re-reading a file before editing it —
 * that is ordinary care, not repeated work.
 */
const SUMMARY_PREAMBLE =
  'Compacted replacement context. Continue the same conversation and active task from ' +
  'this state, starting from what Next names. The recorded actions below are what ' +
  'Forge observed; do not redo an operation recorded as completed merely because this ' +
  'compaction happened. Where something is recorded as unknown, is contradicted by a ' +
  'later fact, or is needed and missing, verify that one thing specifically rather than ' +
  're-establishing the whole task.';

function replacementUserContext(compaction: CompactionState): string {
  const userContext = renderCompactionUserMessages(compaction.userMessages);
  const generation = compaction.generation
    ? `Compaction generation: ${compaction.generation}.`
    : '';
  return [SUMMARY_PREAMBLE, generation, userContext].filter(Boolean).join('\n\n');
}

/**
 * The stored `remember` keys a compaction carries: the newest ones, within the
 * persisted schema's bounds. A key too long to persist is left to
 * `list_memories` rather than failing the whole record's parse on reload.
 */
export function boundMemoryKeys(keys: readonly string[]): string[] {
  return keys
    .filter((key) => key.length > 0 && key.length <= COMPACTION_MEMORY_KEY_MAX_CHARS)
    .slice(-COMPACTION_MEMORY_KEYS_MAX);
}

function renderMemoryKeysBlock(keys: readonly string[] | undefined): string {
  if (!keys || keys.length === 0) return '';
  return (
    '\n\n**Stored memories (keys saved with `remember`, recorded by Forge):** ' +
    keys.join(', ') +
    '\nCall `recall` with a key for its value; `list_memories` shows every key.'
  );
}

function replacementAssistantContext(compaction: CompactionState): string {
  return (
    compaction.summary +
    renderRecordedActionsBlock(compaction.recordedActions ?? [], compaction.omittedActions) +
    (compaction.repoState ?? '') +
    renderMemoryKeysBlock(compaction.memoryKeys) +
    // Last, so it is the closest thing to the resumed turn: it is the one fact
    // here that says where the conversation actually stopped.
    renderLastReplyBlock(compaction.lastReply, compaction.lastReplyFollowedByTools === true)
  );
}

/**
 * Returns `summary` + `messages.slice(fromIndex)`, or the input untouched when
 * no compaction is recorded.
 *
 * A blind slice can strand a `tool` result whose `tool_calls` turn was cut away,
 * which providers reject, so leading orphans are dropped.
 */
export function applyCompactionWindow(
  messages: ChatMessage[],
  compaction: CompactionState | undefined,
): ChatMessage[] {
  if (!compaction || !compaction.summary) return messages;
  return buildCompactionWindow(messages, compaction);
}

/**
 * The window a state would produce, built unconditionally.
 *
 * Separate from `applyCompactionWindow` because that function treats a state
 * with no summary as "not compacted yet" and hands back the whole transcript —
 * correct at request time, and wrong for measurement. `runCompaction`'s floor
 * check measures a candidate carrying a deliberately EMPTY summary (the
 * cheapest state that could exist), and routing that through the short-circuit
 * made the floor equal the uncompacted size on every conversation. The guard
 * then refused every compaction above `MIN_WINDOW_CHARS_FOR_FIT_GUARD` with
 * two identical numbers — the ~300,876 vs ~300,876 shape.
 */
function buildCompactionWindow(
  messages: ChatMessage[],
  compaction: CompactionState,
): ChatMessage[] {
  const from = Math.max(0, Math.min(compaction.fromIndex, messages.length));
  const tail = messages.slice(from);

  // Drop tool results whose originating assistant turn is no longer in the
  // window — they would reference a tool_call_id the model never saw.
  let start = 0;
  while (start < tail.length && tail[start]?.role === 'tool') start += 1;

  return [
    { role: 'user', content: replacementUserContext(compaction) },
    { role: 'assistant', content: replacementAssistantContext(compaction) },
    ...tail.slice(start),
  ];
}

/**
 * Rough size of one message, in characters.
 *
 * Counts what the earlier tail-cost helper skipped and then reported as zero:
 * tool-call names and arguments, and non-string content parts. A compaction
 * that looked like a reduction while the retained tail carried a megabyte of
 * tool arguments was measuring only half the request.
 *
 * Characters, not tokens, and deliberately labelled an estimate everywhere it
 * surfaces — the exact count belongs to the server that tokenises the request.
 */
export function messageCostChars(message: ChatMessage): number {
  let cost = message.role.length;
  if (typeof message.content === 'string') cost += message.content.length;
  else if (Array.isArray(message.content)) {
    // Image and file parts carry their payload here; skipping them is what let
    // an attachment-heavy tail look free.
    for (const part of message.content) cost += JSON.stringify(part).length;
  }
  for (const call of message.tool_calls ?? []) {
    cost += call.function.name.length + call.function.arguments.length;
  }
  if (typeof message.reasoning === 'string') cost += message.reasoning.length;
  return cost;
}

/** Estimated size of the window a compaction state would produce. */
export function compactionWindowChars(
  messages: ChatMessage[],
  compaction: CompactionState | undefined,
): number {
  // Not applyCompactionWindow: a candidate with an empty summary must measure
  // as the window it would really produce, not as the whole transcript.
  const window = compaction ? buildCompactionWindow(messages, compaction) : messages;
  return window.reduce((total, message) => total + messageCostChars(message), 0);
}

export { SUMMARY_PREAMBLE };
export type { CompactionState } from './compactionTypes';
