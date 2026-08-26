import type { ChatMessage } from '../llm/types';
import {
  CHARS_PER_TOKEN,
  MIN_ROUND_HEADROOM_TOKENS,
  computeContextBudget,
} from '../util/contextBudget';
import type { LlamaServerConfig, ModelConfig } from '../config/types';

/** Normal upper bound for a tool result retained verbatim in a tight prompt. */
export const PREFERRED_TOOL_RESULT_CHARS = 8_000;
/** A result smaller than this stays whole unless no input budget exists at all. */
export const MIN_TOOL_RESULT_EXCERPT_CHARS = 2_000;

export interface ToolResultContextResult {
  /** A model-only copy. The stored/sidebar transcript is never changed. */
  messages: ChatMessage[];
  /** Estimated input tokens after the model-only reductions. */
  used: number;
  /** Input budget after reserving enough room for a useful reply. */
  inputBudget: number;
  /** True when the prepared request has room for both prompt and reply. */
  fits: boolean;
  /** IDs whose raw result remains stored but was excerpted for this request. */
  excerptedToolCallIds: string[];
}

function textContent(message: ChatMessage): string | undefined {
  return typeof message.content === 'string' ? message.content : undefined;
}

function excerpt(text: string, toolCallId: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = (start: number, end: number) =>
    `\n\n[Forge retained this full ${text.length}-character tool result. ` +
    `This prompt shows chars 0-${start} and ${end}-${text.length}. ` +
    `To read any exact range, call read_tool_result with ` +
    `{"tool_call_id":"${toolCallId}","offset":${start},"max_chars":6000}.]`;
  // The marker is itself model context, so reserve its space before choosing
  // head/tail. Keep both ends: command headers and final test summaries often
  // live at opposite ends of a result.
  const provisionalMarker = marker(0, text.length);
  const payload = Math.max(0, maxChars - provisionalMarker.length);
  const headLength = Math.ceil(payload * 0.75);
  const tailLength = Math.max(0, payload - headLength);
  const tailStart = Math.max(headLength, text.length - tailLength);
  const fullMarker = marker(headLength, tailStart);
  const finalPayload = Math.max(0, maxChars - fullMarker.length);
  const finalHead = Math.ceil(finalPayload * 0.75);
  const finalTail = Math.max(0, finalPayload - finalHead);
  const finalTailStart = Math.max(finalHead, text.length - finalTail);
  return `${text.slice(0, finalHead)}${marker(finalHead, finalTailStart)}${text.slice(finalTailStart)}`;
}

/**
 * Reduce only tool-result bodies in a model-facing copy until a useful output
 * reserve remains. The original messages, including every raw result, are
 * untouched for persistence, display, and exact `read_tool_result` recovery.
 */
export function prepareToolResultContext(input: {
  messages: ChatMessage[];
  toolTokens: number;
  model: ModelConfig;
  server?: LlamaServerConfig;
  responseReserve?: number;
}): ToolResultContextResult {
  const responseReserve = input.responseReserve ?? MIN_ROUND_HEADROOM_TOKENS;
  const initial = computeContextBudget({
    messages: input.messages,
    toolTokens: input.toolTokens,
    model: input.model,
    server: input.server,
  });
  const inputBudget = Math.max(0, initial.max - responseReserve);
  if (initial.max <= 0 || initial.used <= inputBudget) {
    return {
      messages: input.messages,
      used: initial.used,
      inputBudget,
      fits: initial.max <= 0 || initial.used <= inputBudget,
      excerptedToolCallIds: [],
    };
  }

  const messages = [...input.messages];
  const candidates = messages
    .map((message, index) => ({ message, index, text: textContent(message) }))
    .filter(
      (candidate): candidate is { message: ChatMessage; index: number; text: string } =>
        candidate.message.role === 'tool' &&
        candidate.message.tool_call_id !== undefined &&
        candidate.text !== undefined &&
        candidate.text.length > MIN_TOOL_RESULT_EXCERPT_CHARS,
    )
    .sort((a, b) => b.text.length - a.text.length);
  const excerptedToolCallIds: string[] = [];
  let used = initial.used;

  for (const candidate of candidates) {
    if (used <= inputBudget) break;
    const requiredChars = Math.ceil((used - inputBudget) * CHARS_PER_TOKEN);
    const targetChars = Math.max(
      MIN_TOOL_RESULT_EXCERPT_CHARS,
      Math.min(PREFERRED_TOOL_RESULT_CHARS, candidate.text.length - requiredChars),
    );
    if (targetChars >= candidate.text.length) continue;
    messages[candidate.index] = {
      ...candidate.message,
      content: excerpt(candidate.text, candidate.message.tool_call_id as string, targetChars),
    };
    excerptedToolCallIds.push(candidate.message.tool_call_id as string);
    used = computeContextBudget({
      messages,
      toolTokens: input.toolTokens,
      model: input.model,
      server: input.server,
    }).used;
  }

  return { messages, used, inputBudget, fits: used <= inputBudget, excerptedToolCallIds };
}
