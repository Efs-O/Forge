import type { ChatMessage } from '../llm/types';
import { isCapTruncated } from '../tools/resultCap';

/**
 * Model-facing nudge appended to a tool result that came back truncated.
 *
 * The marker `capResultText` appends already tells the model the result was cut
 * and how to narrow it — but it is passive text sitting inside the result, and
 * a local model has re-run the identical broad search rather than narrowing.
 *
 * This is the same fix `truncationRecovery` applies to cut-off tool-call
 * ARGUMENTS — a hard, concrete "do this now" instruction — moved to the RESULT
 * side. When the result is cut, say so and name the lever, so the model narrows
 * instead of re-running a call that will cut at the same point.
 *
 * Operates on the model-facing copy built in `ModelTurn.prepareMessages`,
 * alongside `supersedeStaleReads`. `conv.messages` is never touched, so the
 * nudge is rebuilt fresh each round and never accumulates.
 */

/** Tools whose cap is a search breadth the model can narrow with a query/glob. */
const SEARCH_TOOLS = new Set(['search_code', 'find_files', 'search_codebase']);

function nudgeFor(toolName: string | undefined): string {
  if (toolName && SEARCH_TOOLS.has(toolName)) {
    return (
      '\n\n[Forge: this result was truncated to fit the context. Do not re-run the same ' +
      'search — it will cut at the same point. Re-run it narrower: a more specific query, ' +
      'or an `include` glob (e.g. "src/**/*.ts"), so the full result fits.]'
    );
  }
  // read_file and the MCP/other caps: the result is a slice of a larger thing,
  // so the lever is to page through it or read a smaller range, not to re-run.
  return (
    '\n\n[Forge: this result was truncated to fit the context. Do not re-run the same ' +
    'call — it will cut at the same point. Read a smaller range, or page the rest with ' +
    '`read_tool_result`, so you get the part you need without re-fetching what you have.]'
  );
}

/**
 * Appends a narrowing nudge to each tool result that `capResultText` cut.
 *
 * Returns the SAME array reference when nothing changed, and clones only the
 * truncated messages — `prepareMessages` runs this on every tool round over
 * transcripts that are usually not truncated.
 */
export function nudgeTruncatedResults(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== 'tool') return message;
    if (typeof message.content !== 'string') return message;
    if (!isCapTruncated(message.content)) return message;
    changed = true;
    return { ...message, content: message.content + nudgeFor(message.name) };
  });
  return changed ? result : messages;
}
