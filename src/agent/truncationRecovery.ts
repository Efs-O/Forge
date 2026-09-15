/**
 * Telling a cut-off tool call apart from a malformed one, and getting the model
 * to succeed on the retry.
 *
 * Split out of `ToolCallingLoop`. llama-server reports both failures with the
 * identical HTTP 500, and reading a truncation as "this model cannot do native
 * tool calls" is what turned one lost call into a lost turn — so the
 * discrimination and the recovery text live together, away from the loop.
 */

import type { ChatCompletionRequest, ChatMessage } from '../llm/types';
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

/** The transcript rows that deliver `guidance` for a cut-off call. */
export function truncationRecoveryMessages(
  truncation: ToolCallTruncatedError,
  guidance: string,
): ChatMessage[] {
  if (!truncation.toolCallId || !truncation.toolName) {
    // The server failed the whole request, so there is no call id to answer —
    // a plain user-role nudge is the portable alternative.
    return [{ role: 'user', content: guidance }];
  }
  // Close the protocol properly: an unanswered tool_call id breaks the next
  // request on strict templates.
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: truncation.toolCallId,
          type: 'function',
          function: { name: truncation.toolName, arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      content: guidance,
      tool_call_id: truncation.toolCallId,
      name: truncation.toolName,
    },
  ];
}

/** Consecutive truncation recoveries tolerated before the turn is failed. */
export const MAX_TRUNCATION_RECOVERIES = 2;

/** Slack left below the computed room, absorbing the crudeness of the token estimate. */
const OUTPUT_CAP_MARGIN_TOKENS = 512;

/** Never cap output below this, however tight the estimate looks. */
const MIN_OUTPUT_CAP_TOKENS = 512;

export const CONTEXT_EXHAUSTED_MESSAGE =
  `Forge: the model's tool call keeps being cut off — the remaining context cannot hold it. ` +
  `Compact the conversation (automatic when auto_compact is enabled) or start a new chat.`;

/**
 * Compactions one turn may run between its own rounds. The shrink guards in
 * `runCompaction` refuse a compaction that buys no room; this caps the case
 * where each one buys a little and the turn eats it straight back.
 */
export const MAX_MID_TURN_COMPACTIONS = 2;

/**
 * Why the next round cannot be sent, or undefined when it can. The three
 * pre-flight refusals of the tool loop, in one place because the loop asks
 * twice: once to decide whether to compact, once more after compacting.
 */
export function contextExhaustionReason(state: {
  outputRoom: number | undefined;
  reasoningReserve: number;
  suppressesThinking: boolean;
  truncationRecoveries: number;
  minRoundHeadroom: number;
}): string | undefined {
  const { outputRoom } = state;
  if (outputRoom === undefined) return undefined;
  // No answer/tool-call room at all. The model-only tool-result window normally
  // prevents this; this covers transcripts that cannot be reduced further.
  if (outputRoom <= 0) return CONTEXT_INPUT_EXHAUSTED_MESSAGE;
  // A round that cannot outlast the model's own reasoning budget cannot
  // succeed: llama.cpp spends thinking and answer from the one budget, so it
  // burns the whole of `max_tokens` inside the thinking block and returns
  // `finish_reason: length` with nothing. A recovery round runs with thinking
  // off, so the reserve does not apply to it. The round that proved this cost
  // 13.5 minutes and produced nothing.
  if (outputRoom <= state.reasoningReserve && !state.suppressesThinking) {
    return CONTEXT_EXHAUSTED_MESSAGE;
  }
  // Only fail early once truncation has already happened this turn: with a
  // healthy turn a thin margin is still enough for a short reply. After a
  // cut-off call, a margin this thin means even a chunked retry cannot fit.
  if (state.truncationRecoveries > 0 && outputRoom < state.minRoundHeadroom) {
    return CONTEXT_EXHAUSTED_MESSAGE;
  }
  return undefined;
}

/** The request itself cannot fit, before any tokens can be generated. */
export const CONTEXT_INPUT_EXHAUSTED_MESSAGE =
  `Forge: the next model request cannot fit in this conversation's remaining context. ` +
  `Earlier context must be compacted before continuing.`;

/** llama-server's pre-generation 400 is the fallback when estimation misses. */
export function isLlamaContextExhaustion(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('exceeds the available context size') ||
    message.includes('exceed_context_size_error')
  );
}

export function isContextExhaustionReason(reason: string | undefined): boolean {
  return reason === CONTEXT_EXHAUSTED_MESSAGE || reason === CONTEXT_INPUT_EXHAUSTED_MESSAGE;
}

export const MAX_ROUNDS_MESSAGE_PREFIX = 'Forge: agent exceeded maximum tool rounds';

/**
 * Transcript marker for a round that spent its entire output budget inside the
 * thinking block and returned no content and no tool call.
 *
 * It goes in the messages, not just a log line: without it the next request
 * sees an assistant turn that simply ends, and the model has no way to tell its
 * own unfinished thought from a completed answer.
 */
export const OUTPUT_BUDGET_EXHAUSTED_NOTICE =
  'Forge: this round hit the output limit while still reasoning, so it produced no ' +
  'answer and no tool call. The thinking above is unfinished. Take the next concrete ' +
  'action directly instead of re-deriving it.';

/**
 * Transcript marker for a round the model ended itself (`finish_reason: stop`)
 * while still inside the thinking block — typically right after llama-server
 * injected `--reasoning-budget-message`. Same purpose as the notice above; a
 * separate string because the cause is not the output limit.
 */
export const REASONING_ONLY_STOP_NOTICE =
  'Forge: this round ended while still reasoning, so it produced no answer and no ' +
  'tool call. The thinking above is unfinished. Take the next concrete action ' +
  'directly instead of re-deriving it.';

/** Consecutive thinking-off retries before a reasoning-only stop is surfaced. */
export const MAX_REASONING_STOP_RETRIES = 1;

/**
 * User-role nudge for the automatic retry. User role rather than assistant: a
 * transcript ending on an assistant message makes llama-server continue that
 * message as a prefill instead of starting a new turn.
 */
export const REASONING_STOP_RETRY_NUDGE =
  'Forge: your previous response ended while still reasoning — no answer and no tool ' +
  'call. Your reasoning above is preserved. Do not reason again: take the next concrete ' +
  'action now, as a tool call or a direct answer.';

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
  return isContextExhaustionReason(message) || message.startsWith(MAX_ROUNDS_MESSAGE_PREFIX);
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
