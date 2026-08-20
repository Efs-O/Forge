import type { ModelConfig } from '../config/types';
import { streamModelChatCompletion } from '../llm/ChatClient';
import type { UsageHandler } from '../llm/OpenAIClient';
import { HtmlDocumentBoilerplateStripper } from '../llm/HtmlDocumentBoilerplateStripper';
import { normalizeRequestForModel } from '../llm/RequestNormalizer';
import { mergeSampling } from '../llm/SamplingMerge';
import { ThinkingChannelStripper } from '../llm/ThinkingChannelStripper';
import type { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from '../llm/types';
import { buildFallbackToolInstructions } from '../tools/FallbackToolPrompt';
import { ToolFailureTracker, stripTools } from '../tools/StripTools';
import {
  StructuredOutputStripper,
  stripStructuredOutputFromFullText,
} from '../tools/StructuredOutputParser';
import { extractFallbackToolCalls } from '../tools/ToolCallFallback';
import { MIN_ROUND_HEADROOM_TOKENS } from '../util/contextBudget';
import { stripThinkingFromFullText } from '../llm/ThinkingChannelStripper';
import { stripHtmlDocumentBoilerplateFromFullText } from '../llm/HtmlDocumentBoilerplateStripper';
import { ToolLoopDetectedError, ToolLoopGuard } from './ToolLoopGuard';
import {
  applyOutputCap,
  asTruncation,
  CONTEXT_EXHAUSTED_MESSAGE,
  isNativeToolJsonParseError,
  MAX_ROUNDS_MESSAGE_PREFIX,
  MAX_TRUNCATION_RECOVERIES,
  truncationGuidance,
} from './truncationRecovery';

export {
  CONTEXT_EXHAUSTED_MESSAGE,
  isTurnCutOffError,
  ROUND_CAP_INCOMPLETE_PREFIX,
} from './truncationRecovery';

export interface ToolCallingLoopOptions {
  baseUrl: string;
  model: ModelConfig;
  messages: ChatMessage[];
  toolDefinitions: ToolDefinition[];
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
  onToken?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onDone?: (finishReason: string | null) => void;
  onRepeatedCall?: () => void;
  onNativeFallback?: () => void;
  /** Called as soon as a transcript entry is appended, before the turn ends. */
  onMessagesChanged?: () => void;
  /** Request the provider's exact execution-side usage in the final stream frame. */
  includeUsage?: boolean;
  onUsage?: UsageHandler;
  /** Fired when a tool call was cut off and the loop is asking for it in chunks. */
  onTruncatedToolCall?: (info: { toolName: string | undefined; approxBytes: number }) => void;
  /**
   * Tokens the model may still generate for these messages — thinking and
   * answer together, since llama.cpp spends both from one budget. Becomes
   * `max_tokens`, and sizes the ceiling offered to a truncated call's retry.
   */
  getOutputRoom?: (messages: ChatMessage[]) => number | undefined;
  isMutatingTool?: (name: string) => boolean;
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
}

function sanitizeText(text: string, stripThinking: boolean): string {
  const withoutThinking = stripThinking ? stripThinkingFromFullText(text) : text;
  const withoutStructured = stripStructuredOutputFromFullText(withoutThinking);
  return stripHtmlDocumentBoilerplateFromFullText(withoutStructured);
}

async function streamOnce(
  options: ToolCallingLoopOptions,
  request: ChatCompletionRequest,
  onToken: (token: string) => void,
  onReasoning: (token: string) => void,
): Promise<{ finishReason: string | null; toolCalls: ToolCall[] | null }> {
  return new Promise((resolve, reject) => {
    let capturedToolCalls: ToolCall[] | null = null;
    void streamModelChatCompletion(
      options.baseUrl,
      request,
      options.model,
      {
        onToken,
        onReasoning,
        onDone: (finishReason) => resolve({ finishReason, toolCalls: capturedToolCalls }),
        onError: reject,
        onToolCalls: (calls) => {
          capturedToolCalls = calls;
        },
        ...(options.onUsage ? { onUsage: options.onUsage } : {}),
      },
      options.signal,
      options.apiKey,
    ).catch(reject);
  });
}

export async function runToolCallingLoop(
  options: ToolCallingLoopOptions,
): Promise<ToolCallingLoopResult> {
  let finalText = '';
  const loopGuard = new ToolLoopGuard();
  let truncationRecoveries = 0;

  for (let round = 0; round < options.maxRounds; round++) {
    options.signal.throwIfAborted();
    const prepared = options.prepareMessages
      ? options.prepareMessages([...options.messages])
      : [...options.messages];
    const outputRoom = options.getOutputRoom?.(prepared);
    // Only fail early once truncation has already happened this turn: with a
    // healthy turn a thin margin is still enough for a short reply, and
    // refusing outright would break those. After a cut-off call, a margin this
    // thin means even a chunked retry cannot fit.
    if (
      truncationRecoveries > 0 &&
      outputRoom !== undefined &&
      outputRoom < MIN_ROUND_HEADROOM_TOKENS
    ) {
      throw new Error(CONTEXT_EXHAUSTED_MESSAGE);
    }
    // A recovery round must not re-think. Measured on a live turn, thinking ate
    // ~4k tokens before the tool call even began — so the retry started with
    // LESS room than the attempt that just failed, and cut at the identical
    // byte. Spending the whole budget on the write is the point of the retry.
    const suppressThinking = truncationRecoveries > 0 && (options.canUseThinkingKwargs ?? false);
    const fallbackMessages =
      options.toolDefinitions.length > 0
        ? [
            ...prepared,
            {
              role: 'system' as const,
              content: buildFallbackToolInstructions(options.toolDefinitions),
            },
          ]
        : prepared;
    const nativeDefinitions =
      options.nativeTools && !options.stripAllTools ? options.toolDefinitions : [];
    const base: ChatCompletionRequest = {
      model: options.model.name,
      messages: nativeDefinitions.length > 0 ? prepared : fallbackMessages,
      stream: true,
      ...(options.includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}),
      ...(nativeDefinitions.length > 0 ? { tools: nativeDefinitions } : {}),
      ...(options.canUseThinkingKwargs && (options.model.think !== undefined || suppressThinking)
        ? {
            chat_template_kwargs: {
              ...(options.model.sampling?.preserve_thinking !== undefined
                ? { preserve_thinking: options.model.sampling.preserve_thinking }
                : {}),
              enable_thinking: suppressThinking ? false : options.model.think,
            },
          }
        : {}),
    };
    const merged = applyOutputCap(
      mergeSampling(base, options.model, {
        allowPreserveThinking: options.canUseThinkingKwargs ?? false,
      }),
      outputRoom,
    );
    const request = normalizeRequestForModel(
      options.stripAllTools ? stripTools(merged) : merged,
      options.model,
    );
    let rawAssistant = '';
    let rawReasoning = '';
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
      options.onReasoning?.(token);
    };

    let streamed: { finishReason: string | null; toolCalls: ToolCall[] | null };
    try {
      streamed = await streamOnce(options, request, tokenHandler, reasoningHandler);
    } catch (err) {
      // Truncation is checked first: it shares llama-server's parse-error
      // message with a genuinely malformed call, but stripping native tools
      // here would re-send the same oversized conversation and ask for the same
      // oversized output — the retry that turned one lost call into a lost turn.
      const truncation = asTruncation(err);
      if (truncation) {
        if (++truncationRecoveries > MAX_TRUNCATION_RECOVERIES) {
          throw new Error(CONTEXT_EXHAUSTED_MESSAGE);
        }
        // Deliberately NOT failureTracker.record(): running out of context is
        // not the model failing at tool calls, and three of these used to
        // disable tool calling for the rest of the chat.
        options.onTruncatedToolCall?.({
          toolName: truncation.toolName,
          approxBytes: truncation.approxBytes,
        });
        const guidance = truncationGuidance(truncation, outputRoom);
        if (truncation.toolCallId && truncation.toolName) {
          // Close the protocol properly: an unanswered tool_call id breaks the
          // next request on strict templates.
          options.messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: truncation.toolCallId,
                type: 'function',
                function: { name: truncation.toolName, arguments: '{}' },
              },
            ],
          });
          options.messages.push({
            role: 'tool',
            content: guidance,
            tool_call_id: truncation.toolCallId,
            name: truncation.toolName,
          });
          options.onMessagesChanged?.();
        } else {
          // The server failed the whole request, so there is no call id to
          // answer — a plain user-role nudge is the portable alternative.
          options.messages.push({ role: 'user', content: guidance });
          options.onMessagesChanged?.();
        }
        continue;
      }
      if (!isNativeToolJsonParseError(err) || nativeDefinitions.length === 0) throw err;
      options.failureTracker?.record();
      options.onNativeFallback?.();
      rawAssistant = '';
      rawReasoning = '';
      thinking = options.stripThinkingChannels ? new ThinkingChannelStripper() : null;
      structured = new StructuredOutputStripper();
      html = new HtmlDocumentBoilerplateStripper();
      const fallbackRequest = normalizeRequestForModel(
        stripTools({ ...base, messages: fallbackMessages }),
        options.model,
      );
      streamed = await streamOnce(options, fallbackRequest, tokenHandler, reasoningHandler);
    }
    // Only reached when the round streamed to completion — the truncation path
    // above continues. Recoveries are consecutive, so a good round clears them.
    truncationRecoveries = 0;

    const trailingTool = structured.flush();
    const trailingHtml = html.push(trailingTool) + html.flush();
    const trailing = thinking ? thinking.push(trailingHtml) : trailingHtml;
    if (trailing) options.onToken?.(trailing);

    const assistantContent = sanitizeText(rawAssistant, options.stripThinkingChannels ?? false);
    const assistantReasoning = options.stripThinkingChannels
      ? ''
      : sanitizeText(rawReasoning, false);
    const calls = streamed.toolCalls?.length
      ? streamed.toolCalls
      : options.toolDefinitions.length > 0 && rawAssistant
        ? extractFallbackToolCalls(rawAssistant)
        : null;
    if (calls?.length) {
      try {
        loopGuard.beforeRound(calls, options.isMutatingTool);
      } catch (error) {
        options.onRepeatedCall?.();
        throw error;
      }
      options.failureTracker?.reset();
      // Carry this round's reasoning on the tool-call turn. rawReasoning resets
      // every round, so dropping it here discarded the model's thinking for every
      // round that ended in a tool call — only the final round's survived, and
      // the sidebar's reasoning bubbles collapsed to one when the turn ended.
      options.messages.push({
        role: 'assistant',
        content: null,
        tool_calls: calls,
        ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
      });
      options.onMessagesChanged?.();
      const beforeDispatch = options.messages.length;
      await options.dispatchToolCalls(calls, options.messages);
      options.onMessagesChanged?.();
      try {
        loopGuard.afterRound(calls, options.messages.slice(beforeDispatch));
      } catch (error) {
        if (error instanceof ToolLoopDetectedError) options.onRepeatedCall?.();
        throw error;
      }
      continue;
    }

    if (assistantContent || assistantReasoning) {
      options.messages.push({
        role: 'assistant',
        content: assistantContent,
        ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
      });
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

  // Out of rounds. Record it in the transcript as an assistant turn so the next
  // request — a resume, or the user's own follow-up — can see that the work was
  // cut short rather than silently re-planning from a transcript that looks
  // complete.
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
