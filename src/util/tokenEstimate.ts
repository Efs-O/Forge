import type { ChatMessage, ContentPart } from '../llm/types';

/**
 * Chars-per-token used for prompt estimates.
 *
 * Was 4, which is the English-prose figure and far too generous for this
 * workload. Measured 2026-08-19 against the live llama-server tokenizer
 * (Qwen3.8-27B): 200,000 chars of real Forge transcript — tool-call JSON, tool
 * results, source excerpts — tokenized to 63,403 tokens, i.e. 3.15 chars/token.
 * At 4 the bar read ~21% under, and since `auto_compact.at` and the 75% warning
 * are both fractions of this number, a bar showing 0.85 was really ~0.95 of the
 * window.
 *
 * 3.1 rather than the measured 3.15 keeps the estimate pessimistic (~2% high),
 * which is the safe direction for a compaction trigger.
 */
export const CHARS_PER_TOKEN = 3.1;

/**
 * Chars-per-token for a TOOL RESULT body, which is most of an agentic prompt.
 *
 * `CHARS_PER_TOKEN` was measured over a whole mixed transcript, but tool
 * results are not the same text as the model's own prose: source excerpts,
 * `git grep` output and JSON payloads carry long runs the BPE merges well.
 * Measured 2026-09-09 against the live llama-server tokenizer
 * (Qwen3.8-Flash-Next) over the 138,571 chars of tool results from session
 * 3c073ca7: 38,155 tokens, i.e. 3.63 chars/token. Assistant `tool_calls` JSON
 * from the same session measured 3.20, close enough to the general figure to
 * leave alone.
 *
 * 3.4 rather than the measured 3.63 keeps this pessimistic (~6% high) for the
 * same reason `CHARS_PER_TOKEN` is: over-estimating the prompt only costs some
 * excerpting, while under-estimating it can overrun the slot.
 */
const TOOL_RESULT_CHARS_PER_TOKEN = 3.4;

/**
 * Prompt scaffolding the message estimate cannot see (chat template, BOS/EOS,
 * role tags) AND the system prompt.
 *
 * The system prompt is the reason this is not small. `injectSystemPrompt`
 * builds it into a NEW array at request time, so it never reaches the
 * `conv.messages` that `estimateTokens` walks — it is invisible to the estimate
 * and has to be carried here. Measured 2026-08-19 on the live tokenizer: the
 * rendered `execute` template plus FORGE.md is 659 tokens before any per-turn
 * context (open-file lists, workspace facts) the template also renders in.
 *
 * 900 covers that measurement plus chat-template scaffolding. It is a floor,
 * not an exact figure: a large FORGE.md will exceed it, so this stays the
 * estimate's known residual error.
 */
export const SYSTEM_AND_TEMPLATE_OVERHEAD = 900;

/** Measured image ceiling (~1,050 tokens); 1,100 covers rounding/tokenizer variation. */
export const IMAGE_PART_TOKENS = 1100;

/**
 * Character cost of one content part for char-measured budgets (compaction).
 * An image costs its token ceiling converted at the caller's rate, never its
 * base64 payload: a 300 KB photo is ~1,100 tokens to the model, not 410K chars.
 */
export function contentPartCostChars(part: ContentPart, charsPerToken: number): number {
  return part.type === 'image_url'
    ? Math.ceil(IMAGE_PART_TOKENS * charsPerToken)
    : part.text.length;
}

/** Chat-template delimiters for each message appended after a measured request. */
export const ADDED_MESSAGE_TOKENS = 16;

export function estimateTokenParts(messages: ChatMessage[]): { text: number; images: number } {
  let text = 0;
  let images = 0;
  for (const m of messages) {
    let chars = 0;
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += part.text.length;
        else if (part.type === 'image_url') images += IMAGE_PART_TOKENS;
      }
    }
    if (m.tool_calls?.length) chars += JSON.stringify(m.tool_calls).length;
    // `reasoning` is deliberately NOT counted: it is kept on the message for the
    // sidebar's thinking pane and is not what gets sent. Counting it inflated
    // the estimate by the whole turn's thinking, since ToolCallingLoop attaches
    // reasoning to EVERY tool-call round. What IS sent under preserve_thinking
    // is `reasoning_content`, set only on the model-facing copy, so that counts.
    if (m.reasoning_content) chars += m.reasoning_content.length;
    const rate = m.role === 'tool' ? TOOL_RESULT_CHARS_PER_TOKEN : CHARS_PER_TOKEN;
    text += Math.ceil(chars / rate);
  }
  return { text, images };
}

export function estimateTokens(messages: ChatMessage[]): number {
  const { text, images } = estimateTokenParts(messages);
  return text + images;
}

/** Token cost of the tool schemas, which the chat template renders into every prompt. */
export function estimateToolTokens(definitions: unknown[]): number {
  return Math.ceil(JSON.stringify(definitions).length / CHARS_PER_TOKEN);
}

export interface EstimatedContextParts {
  instructions: number;
  tools: number;
  conversation: number;
}

/** Estimated composition of one model-facing request: system prompt, tool schemas, the rest. */
export function estimateContextParts(
  messages: ChatMessage[],
  toolTokens: number,
): EstimatedContextParts {
  return {
    instructions: estimateTokens(messages.filter((message) => message.role === 'system')),
    tools: toolTokens,
    conversation: estimateTokens(messages.filter((message) => message.role !== 'system')),
  };
}

/**
 * Attribute a measured context total by the proportions of an estimate. The
 * returned values always sum to the provider-reported total.
 */
export function scaleContextParts(
  parts: EstimatedContextParts,
  used: number,
): EstimatedContextParts {
  const totalEstimate = parts.instructions + parts.tools + parts.conversation;
  const measured = Math.max(0, Math.round(used));
  if (totalEstimate <= 0) return { instructions: 0, tools: 0, conversation: measured };
  const instructions = Math.floor((measured * parts.instructions) / totalEstimate);
  const tools = Math.floor((measured * parts.tools) / totalEstimate);
  return { instructions, tools, conversation: measured - instructions - tools };
}
