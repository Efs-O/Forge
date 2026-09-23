import type { ChatMessage } from '../llm/types';
import { isCapTruncated } from '../tools/resultCap';

/**
 * Model-facing annotation of `read_file` results that re-read a path already
 * read earlier in the same conversation.
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
 * THE SAFETY RULE: annotate result *i* ONLY when a strictly earlier, complete
 * `read_file` result for the same path is present in the same array. The
 * condition looks backwards only, which is what makes it append-only: the
 * earlier result is never touched, so the prompt stays a byte prefix of the
 * next round's prompt.
 *
 * Operates on the model-facing copy built in `ModelTurn.prepareMessages`.
 * `conv.messages` — sidebar, persistence, and the exact bytes
 * `read_tool_result` recovers — is never touched.
 *
 * See docs/plans/PREFIX_REWRITES_PLAN.md §3.
 */

/** Marker text appended to the later result. */
function rereadNotice(path: string): string {
  return (
    `\n\n[Forge: this replaces your earlier read of ${path}. ` +
    `That earlier copy is stale; use this one.]`
  );
}

/**
 * A result that is not a complete copy of the file must never stand in as the
 * authoritative later read, and must never be annotated: for an error or a
 * truncation notice, the text IS the information (it tells the model to retry
 * or to page through `read_tool_result`).
 */
function isCompleteRead(content: string): boolean {
  if (content.length === 0) return false;
  if (content.startsWith('Error') || content.startsWith('[Forge:')) return false;
  return !isCapTruncated(content);
}

function readFilePath(argumentsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    // Malformed args mean no reliable key. No key, no annotation.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const path = (parsed as Record<string, unknown>)['path'];
  if (typeof path !== 'string' || path.length === 0) return undefined;
  // Same file reached as "src\\a.ts" and "src/a.ts" is the same file.
  return path.replace(/\\/g, '/');
}

export function annotateRereads(messages: ChatMessage[]): ChatMessage[] {
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

  // Track which paths have already been completely read.
  const seenPaths = new Set<string>();

  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== 'tool' || message.tool_call_id === undefined) return message;
    if (typeof message.content !== 'string' || !isCompleteRead(message.content)) return message;
    const path = readPathById.get(message.tool_call_id);
    if (path === undefined) return message;
    if (!seenPaths.has(path)) {
      // First complete read of this path — record it and move on.
      seenPaths.add(path);
      return message;
    }
    // A later complete read of a path already seen — append the note.
    changed = true;
    return { ...message, content: message.content + rereadNotice(path) };
  });
  return changed ? result : messages;
}
