import type { ChatMessage } from '../llm/types';
import type { ModelConfig, LlamaServerConfig } from '../config/types';

/**
 * Context accounting shared by the sidebar's token bar and the agent loop.
 *
 * This lived privately inside SidebarProvider, where it could only ever be
 * displayed. The agent loop needs the same numbers to answer a question the
 * display never asked: is there room left for what the model is about to
 * generate? See TOOL_CALL_TRUNCATION_PLAN.md.
 */

/** Chars-per-token used for prompt estimates. Crude, deliberately pessimistic for code. */
const CHARS_PER_TOKEN = 4;

/** Prompt scaffolding the message estimate cannot see (chat template, BOS/EOS, role tags). */
export const SYSTEM_AND_TEMPLATE_OVERHEAD = 200;

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
    if (m.reasoning) chars += m.reasoning.length;
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
