import type { ChatMessage } from '../llm/types';
import { computeContextBudget, minimumOutputReserve } from '../util/contextBudget';
import type { LlamaServerConfig, ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { dropOldestReasoning } from './preserveThinking';

/**
 * Normal upper bound for a tool result retained verbatim in a tight prompt.
 * Sized for a 128k single-slot window: large enough that a whole `--help`
 * dump or a big source read survives one round, small enough that a handful
 * of them still fit before the excerptor has to cut the rest.
 */
export const PREFERRED_TOOL_RESULT_CHARS = 12_000;
/** A result smaller than this stays whole unless no input budget exists at all. */
export const MIN_TOOL_RESULT_EXCERPT_CHARS = 2_000;
const LOW_WATER_FRACTION = 0.7;

const log = getLogger();

export interface ContextTrimState {
  /** Reasoning-carrying assistant turns stripped oldest-first. */
  reasoningDropped: number;
  /** Tool call IDs and their fixed excerpt sizes in chars. */
  excerpts: Map<string, number>;
}

export function createContextTrimState(): ContextTrimState {
  return { reasoningDropped: 0, excerpts: new Map() };
}

export function resetContextTrimState(conversation: { contextTrimState?: ContextTrimState }): void {
  conversation.contextTrimState = createContextTrimState();
}

export interface ToolResultContextResult {
  /** A model-only copy. The stored/sidebar transcript is never changed. */
  messages: ChatMessage[];
  /** Estimated input tokens after the model-only reductions. */
  used: number;
  /** Estimate before any context trimming. */
  rawUsed: number;
  /** Input budget after reserving enough room for a useful reply. */
  inputBudget: number;
  /** True when the prepared request has room for both prompt and reply. */
  fits: boolean;
  /** IDs whose raw result remains stored but was excerpted for this request. */
  excerptedToolCallIds: string[];
  /** True only when this prepare call advanced the persisted trim watermark. */
  trimAdvanced: boolean;
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

function applyTrimState(
  messages: ChatMessage[],
  state: ContextTrimState,
  estimate: (messages: ChatMessage[]) => number,
): { messages: ChatMessage[]; used: number; excerptedToolCallIds: string[] } {
  const carriers = messages.filter((message) => message.reasoning_content !== undefined).length;
  const withoutReasoning = dropOldestReasoning(
    messages,
    Math.min(state.reasoningDropped, carriers),
  );
  let trimmed = withoutReasoning;
  const excerptedToolCallIds: string[] = [];

  for (let index = 0; index < withoutReasoning.length; index += 1) {
    const message = withoutReasoning[index]!;
    const id = message.role === 'tool' ? message.tool_call_id : undefined;
    const size = id ? state.excerpts.get(id) : undefined;
    const text = textContent(message);
    if (id && size !== undefined && text !== undefined && text.length > size) {
      if (trimmed === withoutReasoning) trimmed = [...withoutReasoning];
      trimmed[index] = { ...message, content: excerpt(text, id, size) };
      excerptedToolCallIds.push(id);
    }
  }

  return { messages: trimmed, used: estimate(trimmed), excerptedToolCallIds };
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
  state?: ContextTrimState;
}): ToolResultContextResult {
  const state = input.state ?? createContextTrimState();
  // Reserve thinking AND an answer, not just an answer. `MIN_ROUND_HEADROOM_TOKENS`
  // alone left less output room than the model's own `--reasoning-budget`, which
  // makes a long-thinking round unable to finish by construction — see
  // `minimumOutputReserve`.
  const responseReserve = input.responseReserve ?? minimumOutputReserve(input.model);
  const estimate = (messages: ChatMessage[]) =>
    computeContextBudget({
      messages,
      toolTokens: input.toolTokens,
      model: input.model,
      server: input.server,
    });
  const first = estimate(input.messages);
  const inputBudget = Math.max(0, first.max - responseReserve);
  let applied = applyTrimState(input.messages, state, (messages) => estimate(messages).used);
  let trimAdvanced = false;

  if (first.max > 0 && applied.used > inputBudget) {
    const target = inputBudget * LOW_WATER_FRACTION;
    const carrierCount = input.messages.filter(
      (message) => message.reasoning_content !== undefined,
    ).length;
    while (applied.used > target && state.reasoningDropped < carrierCount) {
      state.reasoningDropped += 1;
      trimAdvanced = true;
      applied = applyTrimState(input.messages, state, (messages) => estimate(messages).used);
    }

    // Short results can seed the first trim. Once fixed excerpts exist, do not
    // chase each new small result and move the watermark on every tool round.
    const includeShortResults = state.excerpts.size === 0;
    const candidates = input.messages
      .map((message) => ({ message, text: textContent(message) }))
      .filter(
        (candidate): candidate is { message: ChatMessage; text: string } =>
          candidate.message.role === 'tool' &&
          candidate.message.tool_call_id !== undefined &&
          candidate.text !== undefined &&
          (candidate.text.length > PREFERRED_TOOL_RESULT_CHARS ||
            (includeShortResults && candidate.text.length > MIN_TOOL_RESULT_EXCERPT_CHARS)),
      )
      .sort((a, b) => b.text.length - a.text.length);

    for (const candidate of candidates) {
      if (applied.used <= target) break;
      const id = candidate.message.tool_call_id!;
      if (state.excerpts.has(id)) continue;
      state.excerpts.set(id, PREFERRED_TOOL_RESULT_CHARS);
      trimAdvanced = true;
      applied = applyTrimState(input.messages, state, (messages) => estimate(messages).used);
    }

    if (applied.used > target) {
      for (const [id, size] of state.excerpts) {
        if (size !== MIN_TOOL_RESULT_EXCERPT_CHARS) {
          state.excerpts.set(id, MIN_TOOL_RESULT_EXCERPT_CHARS);
          trimAdvanced = true;
        }
      }
      if (trimAdvanced) {
        applied = applyTrimState(input.messages, state, (messages) => estimate(messages).used);
      }
    }
  }

  if (trimAdvanced) {
    log.info(
      `[context-trim] advanced reasoning=${state.reasoningDropped} excerpts=${state.excerpts.size} ` +
        `raw=${first.used} sent=${applied.used} budget=${inputBudget} low=${inputBudget * LOW_WATER_FRACTION}`,
    );
  }

  return {
    messages: applied.messages,
    used: applied.used,
    rawUsed: first.used,
    inputBudget,
    fits: first.max <= 0 || applied.used <= inputBudget,
    excerptedToolCallIds: applied.excerptedToolCallIds,
    trimAdvanced,
  };
}
