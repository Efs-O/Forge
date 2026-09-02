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
import type { CompactionState } from './compactionTypes';

const SUMMARY_PREAMBLE =
  'Compacted replacement context. Continue the same conversation and active task from this state.';

function replacementUserContext(compaction: CompactionState): string {
  const userContext = renderCompactionUserMessages(compaction.userMessages);
  const generation = compaction.generation
    ? `Compaction generation: ${compaction.generation}.`
    : '';
  return [SUMMARY_PREAMBLE, generation, userContext].filter(Boolean).join('\n\n');
}

function replacementAssistantContext(compaction: CompactionState): string {
  return (
    compaction.summary +
    renderRecordedActionsBlock(compaction.recordedActions ?? []) +
    (compaction.repoState ?? '') +
    // Last, so it is the closest thing to the resumed turn: it is the one fact
    // here that says where the conversation actually stopped.
    renderLastReplyBlock(compaction.lastReply)
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

export { SUMMARY_PREAMBLE };
export type { CompactionState } from './compactionTypes';
