/**
 * Host-owned user intent carried across compaction generations.
 *
 * Codex-style opaque compaction is unavailable to Forge's local Chat
 * Completions backends. Keeping the user's own words separately from the
 * model-authored summary prevents task identity, corrections, and decisions
 * from being paraphrased away on each generation.
 */

import type { ChatMessage } from '../llm/types';

export const USER_CONTEXT_MAX_MESSAGES = 24;
export const USER_CONTEXT_MESSAGE_MAX_CHARS = 4000;
export const USER_CONTEXT_MAX_CHARS = 12000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[user message truncated]`;
}

function userText(message: ChatMessage): string | undefined {
  if (message.role !== 'user' || message.internal) return undefined;
  if (typeof message.content === 'string') return message.content.trim() || undefined;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  return text || undefined;
}

/**
 * Merge earlier verbatim user context with newly summarized user turns.
 *
 * The first request is always retained. Remaining room is filled newest-first
 * and then rendered in chronological order, so later corrections win the
 * space competition without erasing the task that began the conversation.
 */
export function collectCompactionUserMessages(
  previous: readonly string[] | undefined,
  messages: readonly ChatMessage[],
): string[] {
  const combined = [
    ...(previous ?? []),
    ...messages.map(userText).filter((text): text is string => text !== undefined),
  ].map((text) => truncate(text.trim(), USER_CONTEXT_MESSAGE_MAX_CHARS));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const text of combined) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  if (unique.length === 0) return [];

  const kept = new Set<number>([0]);
  let chars = unique[0]!.length;
  for (let index = unique.length - 1; index > 0; index--) {
    if (kept.size >= USER_CONTEXT_MAX_MESSAGES) break;
    const text = unique[index]!;
    if (chars + text.length > USER_CONTEXT_MAX_CHARS) continue;
    kept.add(index);
    chars += text.length;
  }
  return unique.filter((_, index) => kept.has(index));
}

/**
 * Nothing here is news.
 *
 * `collectCompactionUserMessages` is only ever fed the summarized prefix, so
 * this is history by construction — but it is rendered inside a user-role
 * message, newest last, and the header used to say only that "later entries may
 * refine earlier ones". The newest entry then had every surface property of a
 * fresh instruction. A resumed agent read one as exactly that: the user's [24]
 * "It errored again man" — issued before the fix and answered in full — was
 * taken as news of a new failure, and the agent re-investigated work it had
 * already finished and reported. Two more sessions show the same shape ("User's
 * last message [22] …" when [22] was not the last message).
 *
 * So the block says what it is, and names the authority on what is still open.
 * The last entry is called out by number because it is the one that reads as
 * live. The wording stops at "already received and worked on" rather than
 * "finished": a compaction firing mid-turn cuts while the newest request is
 * still in progress, and telling the agent that one was completed would end the
 * task early — the opposite failure, bought at the same price.
 */
export function renderCompactionUserMessages(messages: readonly string[] | undefined): string {
  if (!messages?.length) return '';
  const rows = messages.map((message, index) => `[${index + 1}] ${message}`).join('\n\n');
  const latest =
    messages.length > 1
      ? ` [${messages.length}] is the most recent of them, NOT a new request — it was received earlier too.`
      : '';
  return (
    'VERBATIM USER REQUESTS AND DECISIONS ALREADY RECEIVED (recorded by Forge; ' +
    'history, kept so the task and its corrections survive in the user’s own words). ' +
    'Every entry below arrived earlier in this same conversation and has already been ' +
    'worked on; later entries refine earlier ones.' +
    latest +
    ' None of them is news arriving now — for what is still open, and how far it got, ' +
    'read the State and Next of the summary that follows.\n' +
    rows
  );
}
