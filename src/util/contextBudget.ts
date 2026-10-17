import type { ChatCompletionRequest, ChatMessage, ContentPart, ToolDefinition } from '../llm/types';
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

/**
 * Headroom below which a round should not attempt a large tool call. Sized to
 * cover a reply plus a chunked write, not a whole file.
 */
export const MIN_ROUND_HEADROOM_TOKENS = 4000;

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
const ADDED_MESSAGE_TOKENS = 16;

function estimateTokenParts(messages: ChatMessage[]): { text: number; images: number } {
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
export function perSlotContext(model: ModelConfig, server?: LlamaServerConfig): number {
  const total = model.spawn?.num_ctx ?? model.num_ctx ?? server?.default_num_ctx ?? 0;
  if (total <= 0) return 0;
  if (kvUnified(model)) return total;
  const parallel = model.spawn?.n_parallel ?? model.n_parallel ?? server?.n_parallel ?? 1;
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

/** Largest correction a reported prompt may apply; beyond it, distrust the report. */
const MAX_ESTIMATE_SCALE = 1.5;

/**
 * How far the estimate fell short of the server's own prompt count, as a
 * factor for the next estimate. The fixed chars-per-token rate is an average:
 * a code-heavy Strata transcript tokenized ~7% denser than it, so `max_tokens`
 * went out 8K too big and the turn died on the server's 400. Only ever
 * tightens — a low report (a cache-only count, say) must not buy room the
 * estimate never promised — and is clamped so a bogus report cannot force
 * compaction on every round. Undefined when there is nothing to compare.
 */
export function promptEstimateScale(estimated: number, reported: number): number | undefined {
  if (!(estimated > 0) || !(reported > 0)) return undefined;
  return Math.min(MAX_ESTIMATE_SCALE, Math.max(1, reported / estimated));
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

/** Structural runtime state: neither field belongs in conversation persistence. */
interface PromptBudgetState {
  promptEstimateScale?: number;
  promptAnchor?: PromptAnchor;
}

export interface OutputRoomBudget {
  /** Undefined only for an unknown window; zero means exhausted. */
  outputRoom: number | undefined;
  extraMarginTokens: number;
}

export function snapshotPromptRequest(request: ChatCompletionRequest): PromptRequestSnapshot {
  return {
    messageCount: request.messages.length,
    prefix: JSON.stringify(request.messages),
    tools: JSON.stringify(request.tools ?? []),
    model: request.model,
    estimatedPrompt:
      estimateTokens(request.messages) +
      estimateToolTokens(request.tools ?? []) +
      SYSTEM_AND_TEMPLATE_OVERHEAD,
  };
}

/** Keep request/usage bookkeeping out of the sidebar's turn orchestration. */
export function createOutputBudgetTracker(
  state: PromptBudgetState,
  model: ModelConfig,
  server?: LlamaServerConfig,
): {
  onUsage: (
    usage: { prompt_tokens: number; completion_tokens: number },
    request: PromptRequestSnapshot,
  ) => void;
  getOutputRoom: (messages: ChatMessage[], tools: ToolDefinition[]) => OutputRoomBudget;
} {
  return {
    onUsage: (usage, request) => {
      const scale = promptEstimateScale(request.estimatedPrompt, usage.prompt_tokens);
      if (scale !== undefined) state.promptEstimateScale = scale;
      if (
        Number.isFinite(usage.prompt_tokens) &&
        usage.prompt_tokens > 0 &&
        Number.isFinite(usage.completion_tokens) &&
        usage.completion_tokens >= 0
      ) {
        state.promptAnchor = {
          ...request,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
        };
      } else {
        delete state.promptAnchor;
      }
    },
    getOutputRoom: (messages, tools) => {
      const budget = computeContextBudget({
        messages,
        tools,
        toolTokens: estimateToolTokens(tools),
        model,
        server,
        estimateScale: state.promptEstimateScale,
        anchor: state.promptAnchor,
      });
      return {
        outputRoom: budget.max > 0 ? budget.outputRoom : undefined,
        extraMarginTokens: budget.extraMarginTokens,
      };
    },
  };
}

export function computeContextBudget(input: {
  messages: ChatMessage[];
  toolTokens?: number;
  /** Actual offered schemas; changing them invalidates the measured prompt. */
  tools?: ToolDefinition[];
  anchor?: PromptAnchor | undefined;
  model: ModelConfig | undefined;
  server?: LlamaServerConfig | undefined;
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
  const max = input.model ? perSlotContext(input.model, input.server) : 0;
  if (max <= 0) return { used, extraMarginTokens, max: 0, outputRoom: 0, headroom: 0 };
  const outputRoom = Math.max(0, max - used);
  const reserve = input.model ? reasoningReserve(input.model) : 0;
  // Subtracting the reserve from what we SEND would double-count it: the model
  // spends its thinking out of max_tokens, so capping at (room - reserve) and
  // then letting it think shrank the answer twice over.
  return { used, extraMarginTokens, max, outputRoom, headroom: Math.max(0, outputRoom - reserve) };
}
