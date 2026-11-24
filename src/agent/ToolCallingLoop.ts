import { HtmlDocumentBoilerplateStripper } from '../llm/HtmlDocumentBoilerplateStripper';
import { ThinkingChannelStripper } from '../llm/ThinkingChannelStripper';
import type { ToolCall } from '../llm/types';
import { StructuredOutputStripper } from '../tools/StructuredOutputParser';
import { extractTextCalls } from '../tools/textCallDefinitions';
import {
  nativeOnlyToolCalls,
  NATIVE_ONLY_PARSE_ERROR,
  textToolCallForms,
} from '../tools/TextToolCallMode';
import { getLogger } from '../util/logger';
import { nudgeBrokenToolCall } from './brokenToolCallMarkup';
import { RoundContextPlan } from './RoundContextPlan';
import { RoundToolDispatch } from './RoundToolDispatch';
import { StreamedAssistantTurn } from './StreamedAssistantTurn';
import { sanitizeText, streamOnce } from './toolCallingStream';
import type { ToolCallingLoopOptions, ToolCallingLoopResult } from './toolCallingLoopTypes';

export type { ToolCallingLoopOptions, ToolCallingLoopResult } from './toolCallingLoopTypes';
import {
  applyOutputCap,
  asTruncation,
  CONTEXT_INPUT_EXHAUSTED_MESSAGE,
  CONTEXT_EXHAUSTED_MESSAGE,
  isLlamaContextExhaustion,
  isNativeToolJsonParseError,
  serverReportedOutputRoom,
  MAX_MID_TURN_COMPACTIONS,
  MAX_ROUNDS_MESSAGE_PREFIX,
  OUTPUT_BUDGET_EXHAUSTED_NOTICE,
  earlyServerLengthStopNotice,
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

export async function runToolCallingLoop(
  options: ToolCallingLoopOptions,
): Promise<ToolCallingLoopResult> {
  let finalText = '';
  let reasoningStopRetries = 0;
  const logger = getLogger();
  // The turn's context budget: what the next round may send, and how many
  // truncation recoveries and compactions it has spent. See `RoundContextPlan`.
  const plan = new RoundContextPlan(options);
  // One round's tool calls, and the repetition guard over their results.
  // See `RoundToolDispatch`.
  const toolRound = new RoundToolDispatch(options);

  for (let round = 0; round < options.maxRounds; round++) {
    options.signal.throwIfAborted();
    const planned = await plan.preflight(round, reasoningStopRetries);
    const { built, toolDefinitions, offeredToolNames, textDefs } = planned;
    // `request` is reassigned below when a native tool call's JSON fails to
    // parse and the round is re-streamed without tools.
    let request = planned.request;
    let rawAssistant = '';
    let rawReasoning = '';
    const streamedAssistant = new StreamedAssistantTurn(options.messages);
    let thinking = options.stripThinkingChannels ? new ThinkingChannelStripper() : null;
    // Which shapes of this round's text may become a tool call at all. A round
    // that offered native tools gets no ```json interpretation, so a tool
    // example in an explanation cannot run a real mutation (audit F1).
    let forms = textToolCallForms(options.model, built.usesNativeTools);
    let structured = new StructuredOutputStripper(forms);
    let html = new HtmlDocumentBoilerplateStripper();
    const tokenHandler = (token: string): void => {
      rawAssistant += token;
      const withoutMarkers = structured.push(token);
      const withoutHtml = html.push(withoutMarkers);
      const visible = thinking ? thinking.push(withoutHtml) : withoutHtml;
      if (visible) {
        streamedAssistant.appendContent(visible);
        options.onToken?.(visible, streamedAssistant.createdAt);
      }
    };
    const reasoningHandler = (token: string): void => {
      if (options.stripThinkingChannels) return;
      rawReasoning += token;
      streamedAssistant.appendReasoning(token);
      options.onReasoning?.(token, streamedAssistant.createdAt);
    };

    let streamed: {
      finishReason: string | null;
      toolCalls: ToolCall[] | null;
      completionTokens?: number;
    };
    try {
      streamed = await streamOnce(
        options,
        request,
        tokenHandler,
        reasoningHandler,
        offeredToolNames,
      );
    } catch (err) {
      // Estimates deliberately err on the safe side, but the server tokenizer
      // remains authoritative. Convert its 400 into Forge's recoverable path
      // instead of surfacing a raw provider failure.
      const reportedRoom = serverReportedOutputRoom(err);
      if (reportedRoom !== undefined && plan.serverRoom === undefined) {
        // Resend with the server's count; the pre-flight compacts if it is too thin.
        plan.serverRoom = reportedRoom;
        continue;
      }
      if (isLlamaContextExhaustion(err) || reportedRoom !== undefined) {
        if (!options.compactMidTurn || plan.midTurnCompactions >= MAX_MID_TURN_COMPACTIONS) {
          throw new Error(CONTEXT_INPUT_EXHAUSTED_MESSAGE);
        }
        plan.forceCompaction = true;
        continue;
      }
      // Truncation is checked first: it shares llama-server's parse-error
      // message with a genuinely malformed call, but stripping native tools
      // here would re-send the same oversized conversation and ask for the same
      // oversized output — the retry that turned one lost call into a lost turn.
      const truncation = asTruncation(err);
      if (truncation) {
        plan.truncatedThisTurn = true;
        if (++plan.truncationRecoveries > MAX_TRUNCATION_RECOVERIES) {
          // Retrying in the same space failed; only more space can help. Let
          // the next round compact first, or fail there if it cannot.
          if (!options.compactMidTurn || plan.midTurnCompactions >= MAX_MID_TURN_COMPACTIONS) {
            throw new Error(CONTEXT_EXHAUSTED_MESSAGE);
          }
          plan.forceCompaction = true;
        }
        // Deliberately NOT counted as a tool failure: running out of context is
        // not the model failing at tool calls, and repeated truncations used to
        // disable tool calling for the rest of the chat.
        options.onTruncatedToolCall?.({
          toolName: truncation.toolName,
          approxBytes: truncation.approxBytes,
        });
        options.messages.push(
          ...truncationRecoveryMessages(
            truncation,
            truncationGuidance(truncation, plan.outputRoom, options.writeChunkLimit),
          ),
        );
        options.onMessagesChanged?.();
        continue;
      }
      if (!isNativeToolJsonParseError(err) || !built.usesNativeTools) throw err;
      if (nativeOnlyToolCalls(options.model)) {
        // No text channel exists to recover into, so the retry below would ask
        // for fenced JSON and then decline to read any of it: the turn would end
        // as ordinary text and run nothing. Name the setting instead.
        throw new Error(NATIVE_ONLY_PARSE_ERROR);
      }
      options.onNativeFallback?.();
      // The retry carries no native tools and does send the fenced-JSON
      // instructions, so text is now the only channel whatever the model says.
      forms = textToolCallForms(options.model, false);
      rawAssistant = '';
      rawReasoning = '';
      thinking = options.stripThinkingChannels ? new ThinkingChannelStripper() : null;
      structured = new StructuredOutputStripper(forms);
      html = new HtmlDocumentBoilerplateStripper();
      const { outputRoom, extraMarginTokens } = plan.measureOutput(built.fallbackRequest);
      const fallbackRefusal = plan.exhaustion();
      if (fallbackRefusal) throw new Error(fallbackRefusal);
      request = applyOutputCap(built.fallbackRequest, outputRoom, extraMarginTokens);
      streamed = await streamOnce(
        options,
        request,
        tokenHandler,
        reasoningHandler,
        offeredToolNames,
      );
    }
    // Only reached when the round streamed to completion — the truncation path
    // above continues. Recoveries are consecutive, so a good round clears them.
    plan.truncationRecoveries = 0;
    plan.serverRoom = undefined;

    const trailingTool = structured.flush();
    const trailingHtml = html.push(trailingTool) + html.flush();
    const trailing = thinking ? thinking.push(trailingHtml) : trailingHtml;
    if (trailing) {
      streamedAssistant.appendContent(trailing);
      options.onToken?.(trailing, streamedAssistant.createdAt);
    }

    // Only a shape the round accepts, naming a real tool, is a call; anything
    // else stays in the answer as the text the user asked for.
    const toolNames = new Set([...toolDefinitions, ...textDefs].map((d) => d.function.name));
    const strip = options.stripThinkingChannels ?? false;
    const assistantContent = sanitizeText(rawAssistant, strip, toolNames, forms);
    const assistantReasoning = options.stripThinkingChannels
      ? ''
      : sanitizeText(rawReasoning, false, toolNames, forms);
    const mayReadText = forms.jsonFence || forms.markers;
    const calls = streamed.toolCalls?.length
      ? streamed.toolCalls
      : toolDefinitions.length > 0 && rawAssistant && mayReadText
        ? extractTextCalls(rawAssistant, toolDefinitions, forms, options, offeredToolNames)
        : null;
    const maxTokens = request.max_tokens;
    const earlyLengthStop =
      streamed.finishReason === 'length' &&
      typeof maxTokens === 'number' &&
      streamed.completionTokens !== undefined &&
      streamed.completionTokens < 0.9 * maxTokens;
    if (earlyLengthStop) {
      logger.info(
        `finish_reason=length completion_tokens=${streamed.completionTokens} ` +
          `max_tokens=${maxTokens} early=true`,
      );
    }
    if (calls?.length) {
      // The retry produced real work, so the next round may think again.
      reasoningStopRetries = 0;
      await toolRound.run(streamedAssistant, calls, assistantContent, assistantReasoning);
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
    const earlyReasoningStop = earlyLengthStop && stoppedWhileReasoning;
    // A normal stop always leaves an answer or a tool call; this one left only
    // thinking, so retry it once with thinking off. The nudge quotes the tail of
    // that reasoning (it is not otherwise sent back), so the retry acts on what
    // was already decided instead of re-deriving it — which is what hit the budget.
    if (
      !assistantContent &&
      stoppedWhileReasoning &&
      (streamed.finishReason !== 'length' || earlyReasoningStop) &&
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
      const stopNotice =
        streamed.finishReason === 'length'
          ? earlyReasoningStop
            ? earlyServerLengthStopNotice(streamed.completionTokens!, maxTokens!)
            : OUTPUT_BUDGET_EXHAUSTED_NOTICE
          : REASONING_ONLY_STOP_NOTICE;
      options.messages.push({
        role: 'assistant',
        content: stopNotice,
        createdAt: Date.now(),
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
      // Markup that never parsed would come back as the answer and leave the
      // lane idle mid-task (session 86b15ced). One nudge per run of such rounds.
      const nudged = nudgeBrokenToolCall(options.messages, assistantContent);
      options.onMessagesChanged?.();
      if (nudged) continue;
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
  const createdAt = Date.now();
  options.messages.push({ role: 'assistant', content: capNotice, createdAt });
  options.onMessagesChanged?.();
  options.onToken?.(`\n\n_${capNotice}_`, createdAt);
  options.onDone?.('max_rounds');
  return {
    finishReason: 'max_rounds',
    finalText: finalText || capNotice,
    rounds: options.maxRounds,
    repeatedCall: false,
    hitRoundCap: true,
  };
}
