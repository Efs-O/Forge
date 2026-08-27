import type { ChatMessage } from '../llm/types';
import type { ModelConfig, LlamaServerConfig } from '../config/types';

/**
 * Context accounting for the agent loop and the sidebar's token bar.
 *
 * Two distinct jobs live here, and confusing them is what the token bar used to
 * do:
 *
 * - MEASURING THE LAST REQUEST — `reportedContextTokens`. Provider-reported,
 *   exact, and the only thing the token bar, the status bar, the HalluMeter
 *   bridge, and the compaction trigger are allowed to display or act on.
 * - PREDICTING THE NEXT REQUEST — `estimateTokens` / `computeContextBudget`.
 *   A chars-per-token approximation, because the request has not been sent and
 *   nobody has tokenized it yet. Its only consumer is the output budget that
 *   sizes `max_tokens` (see docs/plans/TOOL_CALL_TRUNCATION_PLAN.md). It must never reach
 *   a display: a bar that reads 0.85 when the truth is 0.95 is worse than no
 *   bar at all.
 */

/** The usage counters a conversation carries; structural so util stays leaf. */
export interface ReportedUsage {
  /** Prompt tokens in the most recent model request. */
  last_input_tokens?: number;
  /** Completion tokens in the most recent model request. */
  last_output_tokens?: number;
}

/**
 * Context the model actually holds, as the inference server reported it.
 *
 * prompt + completion, because the completion the server just generated becomes
 * prompt on the next round. Reading `prompt_tokens` alone under-reported by a
 * whole response — thousands of tokens on a thinking model — and that number
 * fed the auto-compaction trigger.
 *
 * 0 before the first response of a conversation, which callers render as
 * `0 / max` rather than substituting a guess.
 */
export function reportedContextTokens(conv: ReportedUsage): number {
  return Math.max(0, (conv.last_input_tokens ?? 0) + (conv.last_output_tokens ?? 0));
}

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

/**
 * Headroom below which a round should not attempt a large tool call. Sized to
 * cover a reply plus a chunked write, not a whole file.
 */
export const MIN_ROUND_HEADROOM_TOKENS = 4000;

export function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    let chars = 0;
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += part.text.length;
      }
    } else if (m.content === null && m.tool_calls?.length) {
      chars += JSON.stringify(m.tool_calls).length;
    }
    // `reasoning` is deliberately NOT counted. It is retained on the message for
    // the sidebar's thinking pane, but `ChatMessage.reasoning` is never sent
    // back to the model, so it occupies no prompt tokens. Counting it inflated
    // the bar by the whole turn's thinking — and ToolCallingLoop attaches
    // reasoning to EVERY tool-call round, so on an agentic turn under
    // `--reasoning-budget 6144` that was thousands of phantom tokens per round.
    return sum + Math.ceil(chars / CHARS_PER_TOKEN);
  }, 0);
}

/** Token cost of the tool schemas, which the chat template renders into every prompt. */
export function estimateToolTokens(definitions: unknown[]): number {
  return Math.ceil(JSON.stringify(definitions).length / CHARS_PER_TOKEN);
}

function spawnArgs(model: ModelConfig): string[] {
  return [
    ...(model.spawn?.extra_llama_server_args ?? []),
    ...(model.extra_llama_server_args ?? []),
  ];
}

/**
 * Output tokens llama-server reserves for thinking (`--reasoning-budget N`).
 * Reserved generation never shows up in the prompt estimate, so a budget this
 * large silently eats the headroom a big tool call was counting on.
 */
export function reasoningReserve(model: ModelConfig): number {
  const args = spawnArgs(model);
  const idx = args.indexOf('--reasoning-budget');
  if (idx === -1) return 0;
  const raw = args[idx + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Context available to ONE conversation.
 *
 * `--ctx-size` is the total across slots and `--parallel` divides it
 * (LlamaServerArgs.ts) — so a 131072/n_parallel:4 entry gives each conversation
 * 32768, not 131072. Reading num_ctx alone reported every multi-slot model at
 * several times its real window.
 *
 * Returns 0 when the model has no configured window (cloud providers), which
 * callers treat as "budget unknown, do not gate on it".
 */
export function perSlotContext(model: ModelConfig, server?: LlamaServerConfig): number {
  const total = model.spawn?.num_ctx ?? model.num_ctx ?? server?.default_num_ctx ?? 0;
  if (total <= 0) return 0;
  const parallel = model.spawn?.n_parallel ?? model.n_parallel ?? server?.n_parallel ?? 1;
  return Math.floor(total / Math.max(1, parallel));
}

export interface ContextBudget {
  /** Estimated prompt tokens: messages + tool schemas + template overhead. */
  used: number;
  /** Per-slot context window. 0 when unknown. */
  max: number;
  /**
   * Everything the model may still generate this round: thinking AND the
   * answer, since llama.cpp spends both from one budget. This is the number to
   * send as `max_tokens`.
   */
  outputRoom: number;
  /**
   * What is left for the answer once reserved thinking is spent. Measured on a
   * live Qwen3.8 turn, thinking took ~4k tokens before the tool call started —
   * so this, not outputRoom, is what a large write actually has to fit in.
   */
  headroom: number;
}

export function computeContextBudget(input: {
  messages: ChatMessage[];
  toolTokens?: number;
  model: ModelConfig | undefined;
  server?: LlamaServerConfig | undefined;
}): ContextBudget {
  const used =
    estimateTokens(input.messages) + (input.toolTokens ?? 0) + SYSTEM_AND_TEMPLATE_OVERHEAD;
  const max = input.model ? perSlotContext(input.model, input.server) : 0;
  if (max <= 0) return { used, max: 0, outputRoom: 0, headroom: 0 };
  const outputRoom = Math.max(0, max - used);
  const reserve = input.model ? reasoningReserve(input.model) : 0;
  // Subtracting the reserve from what we SEND would double-count it: the model
  // spends its thinking out of max_tokens, so capping at (room - reserve) and
  // then letting it think shrank the answer twice over.
  return { used, max, outputRoom, headroom: Math.max(0, outputRoom - reserve) };
}
