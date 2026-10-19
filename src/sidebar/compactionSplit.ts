/** Select the summarized prefix and safe, complete recent protocol tail. */

import type { ChatMessage } from '../llm/types';
import { messageCostChars } from './compactionWindow';

/** Cap on the model-facing tail, measured with the window's own message cost. */
export const RETAINED_TAIL_MAX_CHARS = 4000;
const MIN_SUMMARIZED_MESSAGES = 2;

/**
 * Image-bearing user/tool messages count: their text reaches the summarizer
 * with a note per image (`compactionPrompt.ts`). Dropping them lost the text
 * that said what the photos were for.
 */
function isSummarizable(message: ChatMessage): boolean {
  return (
    ((message.role === 'user' || message.role === 'tool') &&
      (typeof message.content === 'string' || Array.isArray(message.content))) ||
    (message.role === 'assistant' &&
      (typeof message.content === 'string' || Boolean(message.tool_calls?.length)))
  );
}

export interface CompactionSplit {
  summarize: ChatMessage[];
  tailStart: number;
}

/** Keep the last affordable user-started exchange as a complete protocol tail. */
export function selectCompactionSplit(
  pending: ChatMessage[],
  tailMaxChars = RETAINED_TAIL_MAX_CHARS,
): CompactionSplit | null {
  const summarizable = pending.filter(isSummarizable);
  if (summarizable.length < MIN_SUMMARIZED_MESSAGES) return null;

  let tailStart = pending.length;
  for (let index = pending.length - 1; index >= 0; index--) {
    if (pending[index]?.role !== 'user') continue;
    const candidate = pending.slice(index);
    const chars = candidate.reduce((sum, message) => sum + messageCostChars(message), 0);
    if (chars > tailMaxChars) break;
    if (pending.slice(0, index).filter(isSummarizable).length < MIN_SUMMARIZED_MESSAGES) break;
    tailStart = index;
    break;
  }

  return { summarize: pending.slice(0, tailStart).filter(isSummarizable), tailStart };
}

/** The floor-mode retry's split: everything is summarized and no tail is kept. */
export function floorModeSplit(pending: ChatMessage[]): CompactionSplit {
  return { summarize: pending.filter(isSummarizable), tailStart: pending.length };
}
