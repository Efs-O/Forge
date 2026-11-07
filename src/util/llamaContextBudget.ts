import type { ChatMessage, ToolDefinition } from '../llm/types';
import type { ModelConfig, ModelProvider, LlamaServerConfig } from '../config/types';
import {
  ADDED_MESSAGE_TOKENS,
  estimateTokenParts,
  estimateTokens,
  SYSTEM_AND_TEMPLATE_OVERHEAD,
} from './tokenEstimate';

/** llama.cpp launch defaults shared by argv construction and context sizing. */
export const DEFAULT_LLAMA_CTX = 4096;
export const DEFAULT_LLAMA_PARALLEL = 4;

/**
 * Headroom below which a round should not attempt a large tool call. Sized to
 * cover a reply plus a chunked write, not a whole file.
 */
export const MIN_ROUND_HEADROOM_TOKENS = 4000;

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
 * The smallest output budget a round can succeed with.
 *
 * Thinking and the answer share ONE budget, so a round needs the whole
 * reasoning reserve PLUS room to say something afterwards. Sizing the reserve
 * at `MIN_ROUND_HEADROOM_TOKENS` alone is what killed session 3c073ca7 on
 * 2026-09-09: the excerptor trimmed the prompt until exactly 4,000 output
 * tokens remained, `applyOutputCap` took its 512-token margin, and the request
 * went out with `max_tokens: 3488` against a `--reasoning-budget 4096`. The
 * model could not reach the budget, so llama.cpp never injected
 * `--reasoning-budget-message`, never closed the thinking block, and the turn
 * died at `finish_reason: length` with no content and no tool call after 13.5
 * minutes. Every later round in that conversation got the identical 3,488 —
 * once a transcript is big enough to engage the excerptor, the failure is
 * permanent, not intermittent.
 *
 * Returns `MIN_ROUND_HEADROOM_TOKENS` for a model with no reasoning budget.
 */
export function minimumOutputReserve(model: ModelConfig): number {
  return reasoningReserve(model) + MIN_ROUND_HEADROOM_TOKENS;
}

/**
 * True when the spawn args end up with `--kv-unified` on. The last flag wins,
 * as it does in llama.cpp's own argument parser.
 */
function kvUnified(model: ModelConfig): boolean {
  let unified = false;
  for (const arg of spawnArgs(model)) {
    if (arg === '--kv-unified' || arg === '-kvu') unified = true;
    else if (arg === '--no-kv-unified' || arg === '-no-kvu') unified = false;
  }
  return unified;
}

/**
 * Context available to ONE conversation.
 *
 * `--ctx-size` is the total across slots and `--parallel` divides it
 * (LlamaServerArgs.ts) — so a 131072/n_parallel:4 entry gives each conversation
 * 32768, not 131072. Reading num_ctx alone reported every multi-slot model at
 * several times its real window.
 *
 * The exception is `--kv-unified`: the slots share one KV buffer and llama.cpp
 * gives each sequence the whole `--ctx-size` (`n_ctx_seq = n_ctx`), so dividing
 * would make Forge compact and trim tool results at a quarter of the real room.
 *
 * Returns 0 when the model has no configured window (cloud providers), which
 * callers treat as "budget unknown, do not gate on it".
 */
export function perSlotContext(
  model: ModelConfig,
  server: LlamaServerConfig | undefined,
  provider: ModelProvider,
): number {
  const isSpawnedLlamaCpp = provider === 'llama.cpp';
  const total = isSpawnedLlamaCpp
    ? (model.spawn?.num_ctx ?? model.num_ctx ?? server?.default_num_ctx ?? DEFAULT_LLAMA_CTX)
    : (model.spawn?.num_ctx ?? model.num_ctx ?? 0);
  if (total <= 0) return 0;
  if (isSpawnedLlamaCpp && kvUnified(model)) return total;
  const parallel = isSpawnedLlamaCpp
    ? (model.spawn?.n_parallel ?? model.n_parallel ?? server?.n_parallel ?? DEFAULT_LLAMA_PARALLEL)
    : 1;
  return Math.floor(total / Math.max(1, parallel));
}

export interface ContextBudget {
  /** Prompt tokens, anchored to usage when possible, otherwise fully estimated. */
  used: number;
  /** Additional slack for the estimated tail; applyOutputCap owns subtraction. */
  extraMarginTokens: number;
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

/** Immutable snapshot taken before streaming, never a reference to mutable transcript rows. */
export interface PromptRequestSnapshot {
  messageCount: number;
  prefix: string;
  tools: string;
  model: string;
  estimatedPrompt: number;
}

export interface PromptAnchor extends PromptRequestSnapshot {
  promptTokens: number;
  completionTokens: number;
}

export function computeContextBudget(input: {
  messages: ChatMessage[];
  toolTokens?: number;
  /** Actual offered schemas; changing them invalidates the measured prompt. */
  tools?: ToolDefinition[];
  anchor?: PromptAnchor | undefined;
  model: ModelConfig | undefined;
  server?: LlamaServerConfig | undefined;
  /** Resolved from the model/group configuration before per-slot sizing. */
  provider?: ModelProvider | undefined;
  /** From `promptEstimateScale`; 1 when the server has not reported yet. */
  estimateScale?: number | undefined;
}): ContextBudget {
  const estimated =
    estimateTokens(input.messages) + (input.toolTokens ?? 0) + SYSTEM_AND_TEMPLATE_OVERHEAD;
  let used = Math.ceil(estimated * (input.estimateScale ?? 1));
  let extraMarginTokens = 0;
  const { anchor, messages } = input;
  if (
    anchor &&
    anchor.model === input.model?.name &&
    anchor.tools === JSON.stringify(input.tools ?? []) &&
    messages.length > anchor.messageCount &&
    messages[anchor.messageCount]?.role === 'assistant' &&
    JSON.stringify(messages.slice(0, anchor.messageCount)) === anchor.prefix
  ) {
    // The generated assistant is already paid for by completion_tokens, including
    // hidden thinking. Only later messages (tool results, user input) are estimated.
    const tail = estimateTokenParts(messages.slice(anchor.messageCount + 1));
    const estimatedNewPart =
      Math.ceil(tail.text * Math.max(input.estimateScale ?? 1, 1)) +
      tail.images +
      ADDED_MESSAGE_TOKENS * (messages.length - anchor.messageCount);
    used = anchor.promptTokens + anchor.completionTokens + estimatedNewPart;
    extraMarginTokens = Math.ceil(1.0 * estimatedNewPart);
  }
  const max = input.model
    ? perSlotContext(
        input.model,
        input.server,
        input.provider ?? input.model.provider ?? 'llama.cpp',
      )
    : 0;
  if (max <= 0) return { used, extraMarginTokens, max: 0, outputRoom: 0, headroom: 0 };
  const outputRoom = Math.max(0, max - used);
  const reserve = input.model ? reasoningReserve(input.model) : 0;
  // Subtracting the reserve from what we SEND would double-count it: the model
  // spends its thinking out of max_tokens, so capping at (room - reserve) and
  // then letting it think shrank the answer twice over.
  return { used, extraMarginTokens, max, outputRoom, headroom: Math.max(0, outputRoom - reserve) };
}
