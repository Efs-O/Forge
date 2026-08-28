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

export function renderCompactionUserMessages(messages: readonly string[] | undefined): string {
  if (!messages?.length) return '';
  const rows = messages.map((message, index) => `[${index + 1}] ${message}`).join('\n\n');
  return (
    'VERBATIM USER REQUESTS AND DECISIONS (recorded by Forge; later entries may refine earlier ones):\n' +
    rows
  );
}
