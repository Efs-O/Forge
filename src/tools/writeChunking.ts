import type { ForgeConfig, LlamaServerConfig, ModelConfig } from '../config/types';
import { MIN_ROUND_HEADROOM_TOKENS, perSlotContext, reasoningReserve } from '../util/contextBudget';

/** Minimum recovery ceiling when the model window cannot be estimated. */
export const MAX_SINGLE_WRITE_CHARS = 6000;

/**
 * Thinking a model spends before its write when no `--reasoning-budget` caps
 * it. The truncation plan measured ~4K on Qwen3.8; doubled for slack.
 */
const THINKING_ALLOWANCE_TOKENS = 8000;

/** Chars per output token for escaped code — the rate truncation recovery uses. */
const WRITE_CHARS_PER_TOKEN = 2;

/**
 * The recovery ceiling for one model, from configuration only — so it stays
 * stable for the life of a model selection. See docs/plans/WRITE_CHUNK_LIMIT_PLAN.md.
 *
 * The worst case is the last round before auto-compaction: the slot is
 * `auto_compact.at` full, so `(1 - at)` of it is left, further capped by the
 * model's own `max_tokens`. Thinking and the round's headroom come out of that.
 * With no known window, or no compaction bounding how full it gets, recovery
 * uses the 6000-character minimum.
 */
export function writeChunkLimit(
  model: ModelConfig,
  server: LlamaServerConfig | undefined,
  autoCompact: ForgeConfig['auto_compact'],
): number {
  const window = perSlotContext(model, server);
  if (window <= 0 || autoCompact?.enabled !== true) return MAX_SINGLE_WRITE_CHARS;
  const at = autoCompact.at ?? 0.85;
  let room = Math.floor(window * (1 - at));
  const maxTokens = model.sampling?.max_tokens;
  if (maxTokens !== undefined && maxTokens > 0) room = Math.min(room, maxTokens);
  const answer =
    room - Math.max(reasoningReserve(model), THINKING_ALLOWANCE_TOKENS) - MIN_ROUND_HEADROOM_TOKENS;
  const chars = Math.floor(answer * WRITE_CHARS_PER_TOKEN);
  return Math.max(MAX_SINGLE_WRITE_CHARS, chars);
}
