import type { ChatMessage } from '../llm/types';

/**
 * Model-facing elision of `read_file` results that a later read replaced.
 *
 * `read_file` is 70% of Forge's whole tool-result token bill — not because any
 * one result is large (the median is ~1,000 tokens) but because a file read at
 * round 2 is re-sent verbatim for every remaining round of the turn. Measured
 * across 197 session logs, 507 of 3,514 reads (14.4%) re-read a path already
 * read in the same turn, leaving both copies in context.
 *
 * The token saving is the smaller half. The real defect is that the model is
 * shown two versions of one file with nothing marking which is current — and
 * after an `edit_file`, the stale copy is the one it read first.
 *
 * THE SAFETY RULE: elide an earlier result ONLY when a strictly later,
 * complete `read_file` result for the same path is present in the same array.
 * The authoritative content is then provably still in context, so nothing is
 * lost. A read whose file was later edited but NOT re-read is deliberately
 * left alone — stale, but the only copy the model has.
 *
 * Operates on the model-facing copy built in `ModelTurn.prepareMessages`.
 * `conv.messages` — sidebar, persistence, and the exact bytes
 * `read_tool_result` recovers — is never touched.
 *
 * See docs/plans/TOKEN_EFFICIENCY_PLAN.md §3.
 */

/** Marker text left in place of a superseded result. */
function supersededNotice(path: string): string {
  return (
    `[Forge: superseded — this file was read again later in this conversation. ` +
    `The current contents of ${path} are in that later result.]`
  );
}

/**
 * A result that is not a complete copy of the file must never stand in as the
 * authoritative later read, and must never be elided itself: for an error or a
 * truncation notice, the text IS the information (it tells the model to retry
 * or to page through `read_tool_result`).
 */
function isCompleteRead(content: string): boolean {
  if (content.length === 0) return false;
  if (content.startsWith('Error') || content.startsWith('[Forge:')) return false;
  return !content.includes('[truncated by ');
}

function readFilePath(argumentsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    // Malformed args mean no reliable key. No key, no supersede.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const path = (parsed as Record<string, unknown>)['path'];
  if (typeof path !== 'string' || path.length === 0) return undefined;
  // Same file reached as "src\\a.ts" and "src/a.ts" is the same file.
  return path.replace(/\\/g, '/');
}

export function supersedeStaleReads(messages: ChatMessage[]): ChatMessage[] {
  // Pair by tool_call_id, never positionally: in-process every tool row
  // carries its id, so the mapping is exact. (The session LOG drops tool
  // names, which is why the offline analyzer must pair by position — that
  // constraint does not apply here.)
  const readPathById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.function.name !== 'read_file') continue;
      const path = readFilePath(call.function.arguments);
      if (path !== undefined) readPathById.set(call.id, path);
    }
  }
  if (readPathById.size === 0) return messages;

  // Last complete read of each path wins.
  const latestIndexByPath = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== 'tool' || message.tool_call_id === undefined) return;
    if (typeof message.content !== 'string' || !isCompleteRead(message.content)) return;
    const path = readPathById.get(message.tool_call_id);
    if (path !== undefined) latestIndexByPath.set(path, index);
  });

  let changed = false;
  const result = messages.map((message, index) => {
    if (message.role !== 'tool' || message.tool_call_id === undefined) return message;
    if (typeof message.content !== 'string' || !isCompleteRead(message.content)) return message;
    const path = readPathById.get(message.tool_call_id);
    if (path === undefined || latestIndexByPath.get(path) === index) return message;
    changed = true;
    return { ...message, content: supersededNotice(path) };
  });
  return changed ? result : messages;
}
