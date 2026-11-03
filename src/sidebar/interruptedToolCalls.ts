/**
 * The transcript repair a reload needs: closing the tool calls that were still
 * running when Forge stopped.
 *
 * Split out of `sessionPersistence.ts` because that file is the session's read
 * and write path and this is a one-question concern — what to say about a call
 * whose result never arrived — and the persistence file had run past ESLint's
 * 500-line stop. `compactionLedger.ts` and the archive tests name the
 * synthesized result, so it is re-exported from where they already import it.
 */
import type { ChatMessage } from '../llm/types';

/**
 * Result synthesized for a tool call that was still running when Forge was
 * reloaded.
 *
 * Exported because `compactionLedger.ts` must classify it as an UNKNOWN
 * outcome: it is not a failure (it carries no `Error:`/`User declined:`
 * prefix), so a classifier that only checks `isFailureResult` would record the
 * interrupted call as a completed one, in a block that vouches for being
 * host-recorded truth.
 */
export const TOOL_INTERRUPTED_RESULT =
  'Forge was reloaded while this tool call was running. Its result is unknown; inspect the workspace before deciding whether to rerun it.';

/**
 * A reload can occur after the assistant has announced tool calls but before
 * the host has appended every result. Close those calls with an explicit
 * unknown outcome so strict chat templates remain valid and the next turn does
 * not pretend the tool completed.
 */
export function repairInterruptedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set(
    messages
      .filter((m) => m.role === 'tool' && typeof m.tool_call_id === 'string')
      .map((m) => m.tool_call_id!),
  );
  const repaired: ChatMessage[] = [];
  for (const message of messages) {
    repaired.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      repaired.push({
        role: 'tool',
        content: TOOL_INTERRUPTED_RESULT,
        tool_call_id: call.id,
        name: call.function.name,
      });
    }
  }
  return repaired;
}
