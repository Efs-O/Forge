/**
 * The agent's own closing words, carried across a compaction verbatim.
 *
 * `selectCompactionSplit` keeps the last user-started exchange intact only when
 * it fits `RETAINED_TAIL_MAX_CHARS`. A long investigation blows through that —
 * one measured exchange cost 21,860 chars against a 4,000 cap — and the split
 * then retains *nothing*, because its fallback is an empty tail rather than a
 * smaller one. Everything the agent said reaches the next turn only as the
 * summarizer's paraphrase.
 *
 * That is how an agent which had just written "Command is pasted — press Enter"
 * resumed believing the command had already run and failed. The summary's Next
 * said otherwise and lost, because a paraphrase of what you said does not carry
 * the force of having said it.
 *
 * Only the assistant half is recorded here: the user half is already the last
 * entry of the verbatim block, and repeating it would spend context to say the
 * same thing twice. `CompactionService` owns WHEN to record it — only when the
 * retained tail carries no assistant words of its own, so a tail that already
 * has them is never duplicated.
 */

import type { ChatMessage } from '../llm/types';

/** Enough for a closing report; short of a second summary. */
export const LAST_REPLY_MAX_CHARS = 1200;

/** The last thing the agent actually said, or nothing if it never spoke. */
export function collectLastReply(messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    // Skip the tool-call turns: `content` is null there, and a turn whose only
    // output was a tool call said nothing to the user.
    if (typeof message.content !== 'string') continue;
    const text = message.content.trim();
    if (!text) continue;
    return text.length <= LAST_REPLY_MAX_CHARS
      ? text
      : `${text.slice(0, LAST_REPLY_MAX_CHARS)}\n…[truncated]`;
  }
  return undefined;
}

export function renderLastReplyBlock(lastReply: string | undefined): string {
  if (!lastReply) return '';
  return (
    '\n\n**Your last message to the user, verbatim (recorded by Forge, not written by the model):**\n' +
    `${lastReply}\n\n` +
    'That message is the most recent thing the user heard from you. Nothing has happened ' +
    'since it was sent unless the messages after this context say so.'
  );
}
