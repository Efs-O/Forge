/**
 * Compaction window: turns a full transcript into the slice the model sees.
 *
 * `/compact` records a summary plus a cut point instead of overwriting the
 * conversation, so the sidebar transcript and the persisted record stay whole.
 * This applies that record at request time.
 */

import type { ChatMessage } from '../llm/types';

export interface CompactionState {
  summary: string;
  fromIndex: number;
}

const SUMMARY_PREAMBLE =
  'Conversation summary. Use this as the working context for future turns in this chat.';

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

  const from = Math.max(0, Math.min(compaction.fromIndex, messages.length));
  const tail = messages.slice(from);

  // Drop tool results whose originating assistant turn is no longer in the
  // window — they would reference a tool_call_id the model never saw.
  let start = 0;
  while (start < tail.length && tail[start]?.role === 'tool') start += 1;

  return [
    { role: 'user', content: SUMMARY_PREAMBLE },
    { role: 'assistant', content: compaction.summary },
    ...tail.slice(start),
  ];
}

export { SUMMARY_PREAMBLE };
