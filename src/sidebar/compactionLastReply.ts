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

/**
 * Share of the budget given to the opening, when the message must be cut.
 *
 * The rest goes to the ending. Keeping only the head — which is what this did
 * originally — throws away exactly the part that matters: a long reply states
 * its next step, its open question or its handover at the *end*. The opening is
 * kept so the resumed agent can still recognise which message this was.
 */
const HEAD_SHARE = 0.35;

const ELISION = '\n…[middle omitted]…\n';

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
    return clampKeepingEnding(text, LAST_REPLY_MAX_CHARS);
  }
  return undefined;
}

/** Keep the opening and the ending, with the elision made explicit. */
export function clampKeepingEnding(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const room = Math.max(0, maxChars - ELISION.length);
  const head = Math.floor(room * HEAD_SHARE);
  const tail = room - head;
  return `${text.slice(0, head)}${ELISION}${text.slice(text.length - tail)}`;
}

/**
 * Did the agent do anything after saying this?
 *
 * The renderer used to assert flatly that nothing had happened since the last
 * reply. That is false whenever the agent spoke and then ran tools — a common
 * shape — and the assertion outranked the tool outcomes recorded elsewhere in
 * the same block, which are the authoritative record of what executed.
 */
export function toolActivityFollowedLastReply(messages: readonly ChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message?.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      return false;
    }
    if (message?.role === 'tool' || (message?.tool_calls?.length ?? 0) > 0) return true;
  }
  return false;
}

export function renderLastReplyBlock(
  lastReply: string | undefined,
  toolsRanAfter: boolean = false,
): string {
  if (!lastReply) return '';
  const temporal = toolsRanAfter
    ? 'That is the last text the user saw from you. Tool calls ran after it: the recorded ' +
      'file changes and command outcomes above are authoritative about what actually executed.'
    : 'That message is the most recent thing the user heard from you, and no tool ran after ' +
      'it. Anything the recorded actions above describe is authoritative about what executed.';
  return (
    '\n\n**Your last message to the user, verbatim (recorded by Forge, not written by the model):**\n' +
    `${lastReply}\n\n` +
    temporal
  );
}
