import type { ChatCompletionRequest, ToolDefinition } from '../llm/types';
import { MIN_ROUND_HEADROOM_TOKENS, reasoningReserve } from '../util/contextBudget';
import { buildRoundRequest, type RoundRequest } from './buildRoundRequest';
import type { ToolCallingLoopOptions } from './toolCallingLoopTypes';
import {
  applyOutputCap,
  CONTEXT_EXHAUSTED_MESSAGE,
  contextExhaustionReason,
  holdSchemaPropertiesUntilTruncation,
  MAX_MID_TURN_COMPACTIONS,
  MID_TURN_COMPACTION_RESET_ROUNDS,
} from './truncationRecovery';

/** What one round may send, as decided by `RoundContextPlan.preflight`. */
export interface RoundPlan {
  built: RoundRequest;
  /** The round's request, already output-capped. */
  request: ChatCompletionRequest;
  toolDefinitions: ToolDefinition[];
  offeredToolNames: string[];
  textDefs: ToolDefinition[];
}

/**
 * One tool-calling turn's context budget: what the next round may send, and how
 * much room it has. It measures the request, applies the mid-turn compaction
 * policy, and refuses a round that cannot fit.
 *
 * It owns the counters the recovery ladder in `ToolCallingLoop` reads and
 * writes, so how many truncation recoveries and compactions a turn has spent,
 * and what room the server itself admitted, live in one place instead of in
 * loose `let`s shared between the pre-flight and the catch.
 */
export class RoundContextPlan {
  truncationRecoveries = 0;
  // Sticky for the turn: the recovery's write + append chunks span several rounds,
  // so once one call is cut off the held schema properties stay offered.
  truncatedThisTurn = false;
  midTurnCompactions = 0;
  // Set when truncation retries ran out: the next round compacts or the turn fails.
  forceCompaction = false;
  // The room a server's own context 400 stated; caps the retry of that round.
  serverRoom: number | undefined;
  /** This round's measurement — the numbers `exhaustion()` reads. */
  outputRoom: number | undefined;
  private extraMarginTokens = 0;
  private lastCompactionRound = 0;
  /** This round's offered definitions, set at the top of `preflight`. */
  private toolDefinitions: ToolDefinition[] = [];
  /** This round's thinking suppression, set at the top of `preflight`. */
  private suppressesThinking = false;

  constructor(private readonly options: ToolCallingLoopOptions) {}

  /**
   * Measure the room for one request. It also stores the two numbers the round
   * is sent with, so `exhaustion()` judges the same request the caller capped.
   */
  measureOutput(request: ChatCompletionRequest) {
    const budget = this.options.getOutputRoom?.(request.messages, request.tools ?? []);
    const estimated = typeof budget === 'object' ? budget.outputRoom : budget;
    const measured = {
      outputRoom:
        this.serverRoom === undefined
          ? estimated
          : Math.min(this.serverRoom, estimated ?? this.serverRoom),
      extraMarginTokens: typeof budget === 'object' ? budget.extraMarginTokens : 0,
      sentForecast: typeof budget === 'object' ? budget.used : undefined,
    };
    this.outputRoom = measured.outputRoom;
    this.extraMarginTokens = measured.extraMarginTokens;
    return measured;
  }

  private measure() {
    const preparedResult = this.options.prepareMessages
      ? this.options.prepareMessages([...this.options.messages])
      : [...this.options.messages];
    const messages = Array.isArray(preparedResult) ? preparedResult : preparedResult.messages;
    // Measure the normalized messages/tools we will send, including fallback
    // instructions, rather than the earlier prepared transcript.
    const built = buildRoundRequest({
      model: this.options.model,
      prepared: messages,
      toolDefinitions: this.toolDefinitions,
      nativeTools: this.options.nativeTools,
      stripAllTools: this.options.stripAllTools,
      includeUsage: this.options.includeUsage,
      maxOutputTokens: this.options.maxOutputTokens,
      canUseThinkingKwargs: this.options.canUseThinkingKwargs,
      suppressThinking: this.suppressesThinking,
      outputRoom: undefined,
    });
    return {
      built,
      ...this.measureOutput(built.request),
      ...(Array.isArray(preparedResult)
        ? {}
        : { rawUsed: preparedResult.rawUsed, trimmedUsed: preparedResult.trimmedUsed }),
      trimAdvanced: !Array.isArray(preparedResult) && preparedResult.trimAdvanced,
    };
  }

  /** Why this round must not be sent at all, or `undefined` if it fits. */
  exhaustion(): string | undefined {
    return contextExhaustionReason({
      outputRoom: this.outputRoom,
      extraMarginTokens: this.extraMarginTokens,
      reasoningReserve: reasoningReserve(this.options.model),
      suppressesThinking: this.suppressesThinking,
      truncationRecoveries: this.truncationRecoveries,
      minRoundHeadroom: MIN_ROUND_HEADROOM_TOKENS,
    });
  }

  /**
   * Decide this round's request: which tools are offered, whether the context
   * fits, compacting mid-turn when it does not. Throws when the round cannot
   * fit and compaction has been spent.
   */
  async preflight(round: number, reasoningStopRetries: number): Promise<RoundPlan> {
    // A recovery round runs with thinking off, so the reasoning reserve does
    // not apply to it — see `contextExhaustionReason` and `suppressThinking`.
    this.suppressesThinking =
      (this.truncationRecoveries > 0 || reasoningStopRetries > 0) &&
      (this.options.canUseThinkingKwargs ?? false);
    this.toolDefinitions = holdSchemaPropertiesUntilTruncation(
      this.options.getToolDefinitions(),
      this.options.holdUntilTruncation,
      this.truncatedThisTurn,
    );
    const offeredToolNames = this.toolDefinitions.map((definition) => definition.function.name);
    const textDefs = this.options.getTextCallDefinitions?.() ?? [];
    let { built, outputRoom, extraMarginTokens, rawUsed, trimmedUsed, sentForecast, trimAdvanced } =
      this.measure();
    // Check context between rounds: post-turn compaction can miss a turn that
    // grows from 60% to exhaustion before it ends.
    if (round - this.lastCompactionRound >= MID_TURN_COMPACTION_RESET_ROUNDS) {
      this.midTurnCompactions = 0;
    }
    if (this.options.compactMidTurn && this.midTurnCompactions < MAX_MID_TURN_COMPACTIONS) {
      const exhausted = this.forceCompaction || this.exhaustion() !== undefined;
      if (
        await this.options.compactMidTurn({
          exhausted,
          rawUsed,
          trimmedUsed,
          sentForecast,
          trimAdvanced,
        })
      ) {
        this.midTurnCompactions++;
        this.lastCompactionRound = round;
        // Room changed, so a pending retry starts a fresh (thinking-off) streak.
        this.truncationRecoveries = Math.min(this.truncationRecoveries, 1);
        this.options.onMessagesChanged?.();
        this.serverRoom = undefined;
        ({
          built,
          outputRoom,
          extraMarginTokens,
          rawUsed,
          trimmedUsed,
          sentForecast,
          trimAdvanced,
        } = this.measure());
      } else if (this.forceCompaction) {
        throw new Error(CONTEXT_EXHAUSTED_MESSAGE);
      }
    } else if (this.forceCompaction) {
      throw new Error(CONTEXT_EXHAUSTED_MESSAGE);
    }
    this.forceCompaction = false;
    const refusal = this.exhaustion();
    if (refusal) throw new Error(refusal);
    // A recovery round must not re-think. Measured on a live turn, thinking ate
    // ~4k tokens before the tool call even began — so the retry started with
    // LESS room than the attempt that just failed, and cut at the identical
    // byte. Spending the whole budget on the write is the point of the retry.
    const request = applyOutputCap(built.request, outputRoom, extraMarginTokens);
    return {
      built,
      request,
      toolDefinitions: this.toolDefinitions,
      offeredToolNames,
      textDefs,
    };
  }
}
