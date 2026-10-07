import type { ForgeConfig, LlamaServerConfig, ModelConfig } from '../config/types';
import type { ToolDefinition } from '../llm/types';
import { MIN_ROUND_HEADROOM_TOKENS, perSlotContext, reasoningReserve } from '../util/contextBudget';

/**
 * Ceiling on the content a single write should carry.
 *
 * A tool call's arguments are generated as one JSON string, so a large file
 * body is one unbroken run of output. When the remaining context cannot hold
 * it, generation stops mid-string, llama-server's chat parser throws, and the
 * whole turn is lost — see docs/plans/TOOL_CALL_TRUNCATION_PLAN.md. Staying under this
 * keeps any single call recoverable, and the cost of being wrong is one extra
 * append rather than a dead turn.
 *
 * 6 KB is well under what fits in a healthy turn (a 15.8 KB write succeeded in
 * the session that motivated this) but small enough that late-turn calls, when
 * headroom is thinnest, still land. It is the floor and the default: a model
 * whose configuration proves more room gets more from `writeChunkLimit`.
 */
export const MAX_SINGLE_WRITE_CHARS = 6000;

/** The chunking instruction, worded once so tool descriptions and recovery guidance agree. */
export const CHUNKED_WRITE_ADVICE =
  `Content over ~${MAX_SINGLE_WRITE_CHARS} characters should be split: ` +
  `write_file for the first chunk, then append_file for each chunk after it.`;

/** Most a single write may carry on any model: one call stays reviewable. */
export const MAX_WRITE_CHUNK_CHARS = 24000;

/**
 * Thinking a model spends before its write when no `--reasoning-budget` caps
 * it. The truncation plan measured ~4K on Qwen3.8; doubled for slack.
 */
const THINKING_ALLOWANCE_TOKENS = 8000;

/** Chars per output token for escaped code — the rate truncation recovery uses. */
const WRITE_CHARS_PER_TOKEN = 2;

/**
 * The write ceiling for one model, from configuration only — so it is stable for
 * the life of a model selection and the tool list (the cached prompt prefix)
 * never changes between rounds. See docs/plans/WRITE_CHUNK_LIMIT_PLAN.md.
 *
 * The worst case is the last round before auto-compaction: the slot is
 * `auto_compact.at` full, so `(1 - at)` of it is left, further capped by the
 * model's own `max_tokens`. Thinking and the round's headroom come out of that.
 * With no known window, or no compaction bounding how full it gets, the
 * conservative 6000 stands.
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
  return Math.max(MAX_SINGLE_WRITE_CHARS, Math.min(MAX_WRITE_CHUNK_CHARS, chars));
}

/** The chunking instruction for a given limit. */
export function chunkedWriteAdvice(limit: number): string {
  return CHUNKED_WRITE_ADVICE.replace(String(MAX_SINGLE_WRITE_CHARS), String(limit));
}

const CHUNKED_WRITE_TOOLS = new Set(['write_file', 'append_file']);

/**
 * The tool definitions with the write tools' advice restated for `limit`. The
 * registered descriptions carry the default advice; a test pins that, so this
 * substitution cannot silently stop matching.
 */
export function withWriteChunkLimit(
  definitions: ToolDefinition[],
  limit: number,
): ToolDefinition[] {
  if (limit === MAX_SINGLE_WRITE_CHARS) return definitions;
  // As they appear inside JSON, so one round-trip restates every occurrence,
  // including the one on the `content` parameter.
  const from = JSON.stringify(CHUNKED_WRITE_ADVICE).slice(1, -1);
  const to = JSON.stringify(chunkedWriteAdvice(limit)).slice(1, -1);
  return definitions.map((definition) =>
    CHUNKED_WRITE_TOOLS.has(definition.function.name)
      ? (JSON.parse(JSON.stringify(definition).split(from).join(to)) as ToolDefinition)
      : definition,
  );
}
