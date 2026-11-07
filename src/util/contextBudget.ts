import type { ChatCompletionRequest, ChatMessage, ToolDefinition } from '../llm/types';
import type { ModelConfig, ModelProvider, LlamaServerConfig } from '../config/types';
import { estimateTokens, estimateToolTokens, SYSTEM_AND_TEMPLATE_OVERHEAD } from './tokenEstimate';
import {
  computeContextBudget,
  type PromptAnchor,
  type PromptRequestSnapshot,
} from './llamaContextBudget';

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

export {
  CHARS_PER_TOKEN,
  SYSTEM_AND_TEMPLATE_OVERHEAD,
  IMAGE_PART_TOKENS,
  contentPartCostChars,
  estimateTokens,
  estimateToolTokens,
  estimateContextParts,
  scaleContextParts,
} from './tokenEstimate';
export type { EstimatedContextParts } from './tokenEstimate';

export {
  DEFAULT_LLAMA_CTX,
  DEFAULT_LLAMA_PARALLEL,
  MIN_ROUND_HEADROOM_TOKENS,
  reasoningReserve,
  minimumOutputReserve,
  perSlotContext,
  computeContextBudget,
} from './llamaContextBudget';
export type { ContextBudget, PromptRequestSnapshot, PromptAnchor } from './llamaContextBudget';

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

/** Structural runtime state: neither field belongs in conversation persistence. */
interface PromptBudgetState {
  promptEstimateScale?: number;
  promptAnchor?: PromptAnchor;
}

export interface OutputRoomBudget {
  /** Undefined only for an unknown window; zero means exhausted. */
  outputRoom: number | undefined;
  extraMarginTokens: number;
  /** Anchored and scaled estimate of the request being sent. */
  used: number | undefined;
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
  provider?: ModelProvider,
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
        provider: provider ?? model.provider ?? 'llama.cpp',
        estimateScale: state.promptEstimateScale,
        anchor: state.promptAnchor,
      });
      return {
        outputRoom: budget.max > 0 ? budget.outputRoom : undefined,
        extraMarginTokens: budget.extraMarginTokens,
        used: budget.max > 0 ? budget.used : undefined,
      };
    },
  };
}
