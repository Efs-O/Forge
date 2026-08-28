/** Select the summarized prefix and safe, complete recent protocol tail. */

import type { ChatMessage } from '../llm/types';

/** Cap on the model-facing tail. Tool results are costed at their later excerpt size. */
export const RETAINED_TAIL_MAX_CHARS = 4000;
const RETAINED_TOOL_RESULT_COST_MAX_CHARS = 2000;
const MIN_SUMMARIZED_MESSAGES = 2;

function isSummarizable(message: ChatMessage): boolean {
  return (
    ((message.role === 'user' || message.role === 'tool') && typeof message.content === 'string') ||
    (message.role === 'assistant' &&
      (typeof message.content === 'string' || Boolean(message.tool_calls?.length)))
  );
}

function retainedTailCost(message: ChatMessage): number {
  if (typeof message.content !== 'string') return 0;
  // ModelTurn excerpts oversized tool results after the compaction window is
  // applied. Cost that bounded form, otherwise one 120k result creates a false
  // zero-tail cliff even though it will never be sent in full.
  return message.role === 'tool'
    ? Math.min(message.content.length, RETAINED_TOOL_RESULT_COST_MAX_CHARS)
    : message.content.length;
}

export interface CompactionSplit {
  summarize: ChatMessage[];
  tailStart: number;
}

/** Keep the last affordable user-started exchange as a complete protocol tail. */
export function selectCompactionSplit(pending: ChatMessage[]): CompactionSplit | null {
  const summarizable = pending.filter(isSummarizable);
  if (summarizable.length < MIN_SUMMARIZED_MESSAGES) return null;

  let tailStart = pending.length;
  for (let index = pending.length - 1; index >= 0; index--) {
    if (pending[index]?.role !== 'user') continue;
    const candidate = pending.slice(index);
    const chars = candidate.reduce((sum, message) => sum + retainedTailCost(message), 0);
    if (chars > RETAINED_TAIL_MAX_CHARS) break;
    if (pending.slice(0, index).filter(isSummarizable).length < MIN_SUMMARIZED_MESSAGES) break;
    tailStart = index;
    break;
  }

  return { summarize: pending.slice(0, tailStart).filter(isSummarizable), tailStart };
}
