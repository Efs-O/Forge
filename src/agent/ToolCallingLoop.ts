import type { ModelConfig } from '../config/types';
import type { UsageHandler } from '../llm/OpenAIClient';
import { HtmlDocumentBoilerplateStripper } from '../llm/HtmlDocumentBoilerplateStripper';
import { ThinkingChannelStripper } from '../llm/ThinkingChannelStripper';
import type { ChatMessage, ToolCall, ToolDefinition } from '../llm/types';
import { ToolFailureTracker } from '../tools/StripTools';
import { StructuredOutputStripper } from '../tools/StructuredOutputParser';
import { extractFallbackToolCalls } from '../tools/ToolCallFallback';
import { MIN_ROUND_HEADROOM_TOKENS, reasoningReserve } from '../util/contextBudget';
import { ToolLoopDetectedError, ToolLoopGuard } from './ToolLoopGuard';
import { StreamedAssistantTurn } from './StreamedAssistantTurn';
import { buildRoundRequest } from './buildRoundRequest';
import { sanitizeText, streamOnce } from './toolCallingStream';
import {
  asTruncation,
  CONTEXT_INPUT_EXHAUSTED_MESSAGE,
  CONTEXT_EXHAUSTED_MESSAGE,
  contextExhaustionReason,
  isLlamaContextExhaustion,
  isNativeToolJsonParseError,
  MAX_MID_TURN_COMPACTIONS,
  MAX_ROUNDS_MESSAGE_PREFIX,
  OUTPUT_BUDGET_EXHAUSTED_NOTICE,
  MAX_REASONING_STOP_RETRIES,
  REASONING_ONLY_STOP_NOTICE,
  reasoningStopRetryNudge,
  MAX_TRUNCATION_RECOVERIES,
  truncationGuidance,
  truncationRecoveryMessages,
} from './truncationRecovery';

export {
  CONTEXT_INPUT_EXHAUSTED_MESSAGE,
  CONTEXT_EXHAUSTED_MESSAGE,
  isContextExhaustionReason,
  isTurnCutOffError,
  ROUND_CAP_INCOMPLETE_PREFIX,
} from './truncationRecovery';

export interface ToolCallingLoopOptions {
  /**
   * The endpoint to call, resolved on EVERY round rather than captured once,
   * for the same reason `getToolDefinitions` is: the answer changes mid-turn.
   *
   * Forge's pool hands out a rotating port, and anything that unloads a model
   * — a `/unload`, the benchmark freeing VRAM, an eviction — brings it back on
   * the next free one behind a NEW controller. A turn holding the old string
   * then dials a dead port and fails in ~11ms with "fetch failed", which is
   * what silently killed a two-hour monitoring loop on 2026-09-05. Resolving
   * through the pool also means a round that arrives mid-restart WAITS for the
   * reload instead of failing instantly.
   */
  resolveBaseUrl: () => Promise<string>;
  model: ModelConfig;
  messages: ChatMessage[];
  /**
   * The model-facing tool list, re-read on EVERY round rather than snapshotted
   * once per turn. A demand-loaded tool group (`load_tool_group`) activates
   * mid-turn, and a tool that reports itself enabled while the next request
   * still omits its schemas is a tool that lies.
   */
  getToolDefinitions: () => ToolDefinition[];
  dispatchToolCalls: (calls: ToolCall[], messages: ChatMessage[]) => Promise<void>;
  prepareMessages?: (messages: ChatMessage[]) => ChatMessage[];
  signal: AbortSignal;
  apiKey?: string;
  maxRounds: number;
  maxOutputTokens?: number;
  nativeTools: boolean;
  stripAllTools?: boolean;
  canUseThinkingKwargs?: boolean;
  stripThinkingChannels?: boolean;
  failureTracker?: ToolFailureTracker;
  failureTrackerKey?: string;
  onToken?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onDone?: (finishReason: string | null) => void;
  onRepeatedCall?: () => void;
  onNativeFallback?: () => void;
  /** Called as soon as a transcript entry is appended, before the turn ends. */
  onMessagesChanged?: () => void;
  /**
   * The text a round produced before calling tools — the model narrating what
   * it is about to do, on a turn that is not over.
   *
   * Distinct from `onToken`, which fires per token and is only ever a live
   * trace: this fires once per round with the finished paragraph, so a surface
   * that delivers messages rather than editing one in place has a whole thought
   * to deliver. Never fires for the round that ends the turn — that text is the
   * answer, and the answer has its own path.
   */
  onRoundNarration?: (text: string) => void;
  /** Request the provider's exact execution-side usage in the final stream frame. */
  includeUsage?: boolean;
  onUsage?: UsageHandler;
  /**
   * Claims messages waiting for the next safe gap after a completed tool round.
   * Returns the messages to inject plus an optional settle step that runs only
   * after they have been pushed and persisted — the remote transport uses it to
   * finish the claimed request once the session is durable.
   */
  drainTells?: () => Promise<{
    messages: ChatMessage[];
    settle?: () => Promise<void>;
  }>;
  /** Fired when a tool call was cut off and the loop is asking for it in chunks. */
  onTruncatedToolCall?: (info: { toolName: string | undefined; approxBytes: number }) => void;
  /**
   * Tokens the model may still generate for these messages — thinking and
   * answer together, since llama.cpp spends both from one budget. Becomes
   * `max_tokens`, and sizes the ceiling offered to a truncated call's retry.
   */
  getOutputRoom?: (messages: ChatMessage[]) => number | undefined;
  isMutatingTool?: (name: string) => boolean;
  /**
   * Compacts the conversation between two rounds of this turn. Resolves true
   * only when it compacted (and left the window ending on a user turn); the
   * loop then re-prepares the request. `exhausted` means the next round cannot
   * be sent as things stand, so the threshold does not apply.
   */
  compactMidTurn?: (request: { exhausted: boolean }) => Promise<boolean>;
}

export interface ToolCallingLoopResult {
  finishReason: string | null;
  finalText: string;
  rounds: number;
  repeatedCall: boolean;
  /**
   * The loop stopped because it ran out of rounds, not because the model was
   * done. Returned rather than thrown: the rounds already spent did real work —
   * files written, tests run — and throwing discarded `finalText` along with any
   * account of it, leaving the user an error where a partial answer belonged.
   */
  hitRoundCap: boolean;
  /**
   * The model ended generation (`stop`, not `length`) while still inside its
   * thinking block: no answer, no tool call. The turn is unfinished.
   */
  stoppedWhileReasoning?: boolean;
}

export async function runToolCallingLoop(
  options: ToolCallingLoopOptions,
): Promise<ToolCallingLoopResult> {
  let finalText = '';
  const loopGuard = new ToolLoopGuard();
  let truncationRecoveries = 0;
  let reasoningStopRetries = 0;
  let midTurnCompactions = 0;
  // Set when truncation retries ran out: the next round compacts or the turn fails.
  let forceCompaction = false;

  for (let round = 0; round < options.maxRounds; round++) {
    options.signal.throwIfAborted();
    const measure = (): { prepared: ChatMessage[]; outputRoom: number | undefined } => {
      const messages = options.prepareMessages
        ? options.prepareMessages([...options.messages])
        : [...options.messages];
      return { prepared: messages, outputRoom: options.getOutputRoom?.(messages) };
    };
    let { prepared, outputRoom } = measure();
    // A recovery round runs with thinking off, so the reasoning reserve does
    // not apply to it — see `contextExhaustionReason` and `suppressThinking`.
    const suppressesThinking =
      (truncationRecoveries > 0 || reasoningStopRetries > 0) &&
      (options.canUseThinkingKwargs ?? false);
    const exhaustion = (): string | undefined =>
      contextExhaustionReason({
        outputRoom,
        reasoningReserve: reasoningReserve(options.model),
        suppressesThinking,
        truncationRecoveries,
        minRoundHeadroom: MIN_ROUND_HEADROOM_TOKENS,
      });
    // Compact between rounds rather than failing the turn and resuming it
    // afterwards: auto-compaction only ran post-turn, so a long turn could
    // start at 60% and die at 100% without the threshold ever being checked.
    if (options.compactMidTurn && midTurnCompactions < MAX_MID_TURN_COMPACTIONS) {
      const exhausted = forceCompaction || exhaustion() !== undefined;
      if (await options.compactMidTurn({ exhausted })) {
        midTurnCompactions++;
        // Room changed, so a pending retry starts a fresh (thinking-off) streak.
        truncationRecoveries = Math.min(truncationRecoveries, 1);
        options.onMessagesChanged?.();
        ({ prepared, outputRoom } = measure());
      } else if (forceCompaction) {
        throw new Error(CONTEXT_EXHAUSTED_MESSAGE);
      }
    } else if (forceCompaction) {
      throw new Error(CONTEXT_EXHAUSTED_MESSAGE);
    }
    forceCompaction = false;
    const refusal = exhaustion();
    if (refusal) throw new Error(refusal);
    // A recovery round must not re-think. Measured on a live turn, thinking ate
    // ~4k tokens before the tool call even began — so the retry started with
    // LESS room than the attempt that just failed, and cut at the identical
    // byte. Spending the whole budget on the write is the point of the retry.
    const suppressThinking = suppressesThinking;
    const toolDefinitions = options.getToolDefinitions();
    const built = buildRoundRequest({
      model: options.model,
      prepared,
      toolDefinitions,
      nativeTools: options.nativeTools,
      stripAllTools: options.stripAllTools,
      includeUsage: options.includeUsage,
      maxOutputTokens: options.maxOutputTokens,
      canUseThinkingKwargs: options.canUseThinkingKwargs,
      suppressThinking,
      outputRoom,
    });
    const request = built.request;
    let rawAssistant = '';
    let rawReasoning = '';
    const streamedAssistant = new StreamedAssistantTurn(options.messages);
    let thinking = options.stripThinkingChannels ? new ThinkingChannelStripper() : null;
    let structured = new StructuredOutputStripper();
    let html = new HtmlDocumentBoilerplateStripper();
    const tokenHandler = (token: string): void => {
      rawAssistant += token;
      const withoutMarkers = structured.push(token);
      const withoutHtml = html.push(withoutMarkers);
      const visible = thinking ? thinking.push(withoutHtml) : withoutHtml;
      if (visible) options.onToken?.(visible);
    };
    const reasoningHandler = (token: string): void => {
      if (options.stripThinkingChannels) return;
      rawReasoning += token;
      streamedAssistant.appendReasoning(token);
      options.onReasoning?.(token);
    };

    let streamed: { finishReason: string | null; toolCalls: ToolCall[] | null };
    try {
      streamed = await streamOnce(options, request, tokenHandler, reasoningHandler);
    } catch (err) {
      // Estimates deliberately err on the safe side, but the server tokenizer
      // remains authoritative. Convert its 400 into Forge's recoverable path
      // instead of surfacing a raw provider failure.
      if (isLlamaContextExhaustion(err)) {
        if (!options.compactMidTurn || midTurnCompactions >= MAX_MID_TURN_COMPACTIONS) {
          throw new Error(CONTEXT_INPUT_EXHAUSTED_MESSAGE);
        }
        forceCompaction = true;
        continue;
      }
      // Truncation is checked first: it shares llama-server's parse-error
      // message with a genuinely malformed call, but stripping native tools
      // here would re-send the same oversized conversation and ask for the same
      // oversized output — the retry that turned one lost call into a lost turn.
      const truncation = asTruncation(err);
      if (truncation) {
        if (++truncationRecoveries > MAX_TRUNCATION_RECOVERIES) {
          // Retrying in the same space failed; only more space can help. Let
          // the next round compact first, or fail there if it cannot.
          if (!options.compactMidTurn || midTurnCompactions >= MAX_MID_TURN_COMPACTIONS) {
            throw new Error(CONTEXT_EXHAUSTED_MESSAGE);
          }
          forceCompaction = true;
        }
        // Deliberately NOT failureTracker.record(): running out of context is
        // not the model failing at tool calls, and three of these used to
        // disable tool calling for the rest of the chat.
        options.onTruncatedToolCall?.({
          toolName: truncation.toolName,
          approxBytes: truncation.approxBytes,
        });
        options.messages.push(
          ...truncationRecoveryMessages(truncation, truncationGuidance(truncation, outputRoom)),
        );
        options.onMessagesChanged?.();
        continue;
      }
      if (!isNativeToolJsonParseError(err) || !built.usesNativeTools) throw err;
      options.failureTracker?.record(options.failureTrackerKey);
      options.onNativeFallback?.();
      rawAssistant = '';
      rawReasoning = '';
      thinking = options.stripThinkingChannels ? new ThinkingChannelStripper() : null;
      structured = new StructuredOutputStripper();
      html = new HtmlDocumentBoilerplateStripper();
      const fallbackRequest = built.fallbackRequest;
      streamed = await streamOnce(options, fallbackRequest, tokenHandler, reasoningHandler);
    }
    // Only reached when the round streamed to completion — the truncation path
    // above continues. Recoveries are consecutive, so a good round clears them.
    truncationRecoveries = 0;

    const trailingTool = structured.flush();
    const trailingHtml = html.push(trailingTool) + html.flush();
    const trailing = thinking ? thinking.push(trailingHtml) : trailingHtml;
    if (trailing) options.onToken?.(trailing);

    // Only a ```json block naming a real tool is a call; any other is shown.
    const toolNames = new Set(toolDefinitions.map((d) => d.function.name));
    const strip = options.stripThinkingChannels ?? false;
    const assistantContent = sanitizeText(rawAssistant, strip, toolNames);
    const assistantReasoning = options.stripThinkingChannels
      ? ''
      : sanitizeText(rawReasoning, false, toolNames);
    const calls = streamed.toolCalls?.length
      ? streamed.toolCalls
      : toolDefinitions.length > 0 && rawAssistant
        ? extractFallbackToolCalls(rawAssistant, toolDefinitions)
        : null;
    if (calls?.length) {
      try {
        loopGuard.beforeRound(calls, options.isMutatingTool);
      } catch (error) {
        options.onRepeatedCall?.();
        throw error;
      }
      options.failureTracker?.reset(options.failureTrackerKey);
      // The retry produced real work, so the next round may think again.
      reasoningStopRetries = 0;
      // Carry this round's reasoning on the tool-call turn. rawReasoning resets
      // every round, so dropping it here discarded the model's thinking for every
      // round that ended in a tool call — only the final round's survived, and
      // the sidebar's reasoning bubbles collapsed to one when the turn ended.
      // A model may narrate its next action before emitting the tool call. That
      // commentary has already streamed into the sidebar, so retain it on the
      // protocol turn as well; otherwise the next session sync replaces the
      // live row with `content: null` and the visible text disappears.
      streamedAssistant.completeToolCall(calls, assistantContent, assistantReasoning);
      options.onMessagesChanged?.();
      // A question is the boundary of this round. Keep any pre-question
      // commentary in the transcript, but do not send it as a separate remote
      // notification while the user is waiting for the question itself. Only a
      // round that is *purely* a question suppresses the narration: a mixed
      // round (e.g. write_file + ask_user) did real work the user should hear
      // about, so its commentary still reaches remote surfaces.
      const isQuestionOnlyRound = calls.every((call) => call.function.name === 'ask_user');
      if (assistantContent.trim() && !isQuestionOnlyRound)
        options.onRoundNarration?.(assistantContent);
      const beforeDispatch = options.messages.length;
      await options.dispatchToolCalls(calls, options.messages);
      options.onMessagesChanged?.();
      try {
        const warned = loopGuard.afterRound(
          calls,
          options.messages.slice(beforeDispatch),
          options.isMutatingTool,
        );
        if (warned) options.onMessagesChanged?.();
      } catch (error) {
        if (error instanceof ToolLoopDetectedError) options.onRepeatedCall?.();
        throw error;
      }
      const drained = await options.drainTells?.();
      if (drained && drained.messages.length > 0) {
        options.messages.push(...drained.messages);
        options.onMessagesChanged?.();
      }
      // Settle always runs when present, even with no messages: a failing tell
      // source yields no messages but still must surface its error, so the
      // rethrow from settle cannot be skipped by an empty drain. When messages
      // were pushed, persist ran above, so the claim is settled only once the
      // injected turn is durable; if that persist threw we never reach here and
      // the record stays `running` for the store's restart recovery.
      await drained?.settle?.();
      continue;
    }

    // A `length` stop with nothing to show is a truncated round, not an answer.
    // The model spent its whole budget inside the thinking block and was cut
    // off mid-sentence, so there is no content and no tool call to act on.
    // Flushing it as a normal completion is what made session 3c073ca7 appear
    // to simply stop: `completeAnswer('')` returned an empty `finalText`, the
    // loop exited, and neither the transcript nor the sidebar recorded a
    // reason. Record it in the transcript so the next request knows the work
    // stopped rather than finished.
    //
    // A `stop` can end the same way. Session 79db75af: llama-server injected
    // `--reasoning-budget-message`, then the model emitted EOS without ever
    // leaving the thinking block — `finish_reason=stop text_chars=0
    // reasoning_chars=14950 tool_deltas=0`. That silently ended 13 turns in
    // three days, so the guard keys on the shape, not on the finish reason.
    const stoppedWhileReasoning =
      !assistantContent.trim() &&
      rawReasoning.trim().length > 0 &&
      streamed.finishReason !== 'cancelled';
    // A normal stop always leaves an answer or a tool call; this one left only
    // thinking, so retry it once with thinking off. The nudge quotes the tail of
    // that reasoning (it is not otherwise sent back), so the retry acts on what
    // was already decided instead of re-deriving it — which is what hit the budget.
    if (
      !assistantContent &&
      stoppedWhileReasoning &&
      streamed.finishReason !== 'length' &&
      reasoningStopRetries < MAX_REASONING_STOP_RETRIES
    ) {
      reasoningStopRetries++;
      streamedAssistant.completeAnswer(assistantContent, assistantReasoning);
      // Internal: the model and the session log need it; the sidebar must not
      // render Forge's nudge as something the user typed.
      options.messages.push({
        role: 'user',
        content: reasoningStopRetryNudge(assistantReasoning),
        internal: true,
      });
      options.onMessagesChanged?.();
      continue;
    }
    if (!assistantContent && (streamed.finishReason === 'length' || stoppedWhileReasoning)) {
      streamedAssistant.completeAnswer(assistantContent, assistantReasoning);
      options.messages.push({
        role: 'assistant',
        content:
          streamed.finishReason === 'length'
            ? OUTPUT_BUDGET_EXHAUSTED_NOTICE
            : REASONING_ONLY_STOP_NOTICE,
      });
      options.onMessagesChanged?.();
      options.onDone?.(streamed.finishReason);
      return {
        finishReason: streamed.finishReason,
        finalText: '',
        rounds: round + 1,
        repeatedCall: false,
        hitRoundCap: false,
        stoppedWhileReasoning: streamed.finishReason !== 'length',
      };
    }
    if (assistantContent || assistantReasoning) {
      streamedAssistant.completeAnswer(assistantContent, assistantReasoning);
      options.onMessagesChanged?.();
      finalText = assistantContent;
    }
    options.onDone?.(streamed.finishReason);
    return {
      finishReason: streamed.finishReason,
      finalText,
      rounds: round + 1,
      repeatedCall: false,
      hitRoundCap: false,
    };
  }

  // Record the round cap in the transcript so the next request knows work stopped early.
  const capNotice = `${MAX_ROUNDS_MESSAGE_PREFIX} (${options.maxRounds}).`;
  options.messages.push({ role: 'assistant', content: capNotice });
  options.onMessagesChanged?.();
  options.onToken?.(`

_${capNotice}_`);
  options.onDone?.('max_rounds');
  return {
    finishReason: 'max_rounds',
    finalText: finalText || capNotice,
    rounds: options.maxRounds,
    repeatedCall: false,
    hitRoundCap: true,
  };
}
