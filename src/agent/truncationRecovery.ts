/**
 * Telling a cut-off tool call apart from a malformed one, and getting the model
 * to succeed on the retry.
 *
 * Split out of `ToolCallingLoop`. llama-server reports both failures with the
 * identical HTTP 500, and reading a truncation as "this model cannot do native
 * tool calls" is what turned one lost call into a lost turn — so the
 * discrimination and the recovery text live together, away from the loop.
 */

import type { ChatCompletionRequest } from '../llm/types';
import { CHUNKED_WRITE_ADVICE, MAX_SINGLE_WRITE_CHARS } from '../tools/writeChunking';
import {
  ToolCallTruncatedError,
  isToolCallTruncatedError,
  isTruncationParseError,
} from '../llm/ToolCallTruncatedError';

export function isNativeToolJsonParseError(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(
    'Failed to parse tool call arguments as JSON',
  );
}

/**
 * Tells a cut-off tool call apart from a malformed one. Both arrive from
 * llama-server as the same "Failed to parse tool call arguments as JSON" 500,
 * but they need opposite responses — see ToolCallTruncatedError. A truncation
 * is either already typed (the client saw the partial deltas) or identifiable
 * from the parser's own wording in the 500 body.
 */
export function asTruncation(err: unknown): ToolCallTruncatedError | undefined {
  if (isToolCallTruncatedError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (isNativeToolJsonParseError(message) && isTruncationParseError(message)) {
    return new ToolCallTruncatedError({ finishReason: 'length', message });
  }
  return undefined;
}

/**
 * What the model is told after a truncated call. It must convey three things
 * the old "malformed tool arguments" result did not: nothing was written, the
 * cause was size rather than syntax, and the concrete way to succeed on retry.
 */
export function truncationGuidance(
  err: ToolCallTruncatedError,
  outputRoom: number | undefined,
): string {
  const target = err.toolName ? `Your ${err.toolName} call` : 'Your last tool call';
  // A generic "use smaller chunks" loses to the user's own earlier "write the
  // whole file, do not summarise" — the model re-sent the identical call twice
  // in the live test. A hard character ceiling for THIS call is an instruction
  // it can follow without contradicting the task.
  // The retry runs with thinking off, so the whole of outputRoom is available
  // to the write. ~2 chars per token for escaped code, minus slack.
  const ceiling =
    outputRoom !== undefined && outputRoom > 0
      ? Math.max(1000, Math.min(MAX_SINGLE_WRITE_CHARS, Math.floor(outputRoom * 2) - 1000))
      : MAX_SINGLE_WRITE_CHARS;
  return (
    `${target} was cut off after ${err.approxBytes} bytes of arguments and was NOT executed — ` +
    `nothing was written. This is an output-size limit, not a formatting mistake, and repeating ` +
    `the same call will fail the same way.\n` +
    `HARD LIMIT for your next call: the "content" argument must be at most ${ceiling} characters. ` +
    `This overrides any earlier instruction to write the whole file in one go — the file still ` +
    `ends up complete, just written across several calls.\n` +
    `Do this now: ${CHUNKED_WRITE_ADVICE} Keep thinking short; it spends the same budget as the write.`
  );
}

/** Consecutive truncation recoveries tolerated before the turn is failed. */
export const MAX_TRUNCATION_RECOVERIES = 2;

/** Slack left below the computed room, absorbing the crudeness of the token estimate. */
const OUTPUT_CAP_MARGIN_TOKENS = 512;

/** Never cap output below this, however tight the estimate looks. */
const MIN_OUTPUT_CAP_TOKENS = 512;

export const CONTEXT_EXHAUSTED_MESSAGE =
  `Forge: the model's tool call keeps being cut off — the remaining context cannot hold it. ` +
  `Use /compact or start a new chat, then ask for the file in smaller pieces.`;

export const MAX_ROUNDS_MESSAGE_PREFIX = 'Forge: agent exceeded maximum tool rounds';

/**
 * Prefix of the incomplete-turn reason recorded when the loop runs out of tool
 * rounds. The post-turn resume matches on it, so both sides must agree — hence
 * one constant rather than a literal at each end.
 */
export const ROUND_CAP_INCOMPLETE_PREFIX = 'the agent ran out of tool rounds';

/**
 * True when the loop aborted for want of room rather than finishing the work —
 * the two cases a freshly compacted context could actually resume.
 */
export function isTurnCutOffError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message === CONTEXT_EXHAUSTED_MESSAGE || message.startsWith(MAX_ROUNDS_MESSAGE_PREFIX);
}

/**
 * Lowers `max_tokens` to what the slot can actually generate.
 *
 * The configured value is unrelated to reality in both directions — 4096 by
 * default, or larger than the whole context where a config sets it — so
 * llama-server would happily start a generation it has no room to finish. Only
 * ever lowers: a deliberately small setting is left alone.
 */
export function applyOutputCap(
  request: ChatCompletionRequest,
  outputRoom: number | undefined,
): ChatCompletionRequest {
  if (outputRoom === undefined || outputRoom <= 0) return request;
  const cap = Math.max(MIN_OUTPUT_CAP_TOKENS, outputRoom - OUTPUT_CAP_MARGIN_TOKENS);
  if (request.max_tokens !== undefined && request.max_tokens <= cap) return request;
  return { ...request, max_tokens: cap };
}
