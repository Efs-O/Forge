import type { ChatMessage } from '../llm/types';

/**
 * A model can end a round by printing its own tool-call markup instead of
 * emitting a call. Nothing parses, so nothing runs, and the loop's end-of-turn
 * branch hands that markup back as the answer: session 86b15ced (2026-11-17)
 * finished `<tool_call>…</tool_call>` with no function name, the turn
 * ended `completed`, and the lane went idle mid-task. One internal nudge turns
 * that silent stop into a retry.
 */

/** Broken rounds in one run before the answer is accepted as the turn's end. */
export const MAX_BROKEN_TOOL_CALL_RETRIES = 1;

/** The internal user message that asks the model to try the call again. */
export const BROKEN_TOOL_CALL_NUDGE =
  'Your last message was tool-call markup that did not parse into a call, so nothing ran. ' +
  "Make the tool call again through the tool-calling interface, with the tool's name and its " +
  'JSON arguments, or answer in plain text if you are done.';

/**
 * True when the answer *is* tool-call markup rather than an answer.
 *
 * Whole positions only: a line that mentions `<tool_call>` mid-sentence is the
 * explanation the user asked for, and a closing tag in the middle of prose is
 * prose. Only an answer that opens or ends with the markup is a call that died.
 */
export function isBrokenToolCallAnswer(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith('<tool_call>') ||
    trimmed.startsWith('<function=') ||
    trimmed.endsWith('</tool_call>') ||
    trimmed.endsWith('</function>')
  );
}

/**
 * Push Forge's nudge when this round's answer is unparsed markup and this run
 * of rounds has not used its retry; report whether the loop should ask again.
 *
 * The budget is read off the transcript, not a loop counter: walking back over
 * the rounds since the last tool result or real user message, an earlier nudge
 * is there. So it resets exactly where the reasoning-stop counter resets — when
 * real work lands — and a mid-turn compaction cannot reset it and let a second
 * nudge through. A second broken answer ends the turn, so the retry cannot loop.
 */
export function nudgeBrokenToolCall(messages: ChatMessage[], content: string): boolean {
  if (
    !isBrokenToolCallAnswer(content) ||
    countNudgesInRun(messages) >= MAX_BROKEN_TOOL_CALL_RETRIES
  )
    return false;
  // Internal: the model and the session log need it; the sidebar must not
  // render Forge's nudge as something the user typed.
  messages.push({ role: 'user', content: BROKEN_TOOL_CALL_NUDGE, internal: true });
  return true;
}

/**
 * Nudges already sent for this run. An assistant row is a round that said
 * nothing; a tool result means real work landed and the run is over; a
 * non-internal user row means the user spoke, which starts a fresh run.
 */
function countNudgesInRun(messages: readonly ChatMessage[]): number {
  let nudges = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'assistant') continue;
    if (message.role !== 'user') return nudges;
    if (message.content === BROKEN_TOOL_CALL_NUDGE) nudges++;
    else if (message.internal !== true) return nudges;
  }
  return nudges;
}
