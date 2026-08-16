import type { ModelConfig } from '../config/types';
import { streamModelChatCompletion } from '../llm/ChatClient';
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
import { CHUNKED_WRITE_ADVICE, MAX_SINGLE_WRITE_CHARS } from '../tools/writeChunking';
import {
  ToolCallTruncatedError,
  isToolCallTruncatedError,
  isTruncationParseError,
} from '../llm/ToolCallTruncatedError';
import { MIN_ROUND_HEADROOM_TOKENS } from '../util/contextBudget';
import { stripThinkingFromFullText } from '../llm/ThinkingChannelStripper';
import { stripHtmlDocumentBoilerplateFromFullText } from '../llm/HtmlDocumentBoilerplateStripper';
import { ToolLoopDetectedError, ToolLoopGuard } from './ToolLoopGuard';

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
  /** Fired with the fully normalized request immediately before it is sent. */
  onPreparedRequest?: (request: ChatCompletionRequest) => void;
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
}

function sanitizeText(text: string, stripThinking: boolean): string {
  const withoutThinking = stripThinking ? stripThinkingFromFullText(text) : text;
  const withoutStructured = stripStructuredOutputFromFullText(withoutThinking);
  return stripHtmlDocumentBoilerplateFromFullText(withoutStructured);
}

function isNativeToolJsonParseError(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(
    'Failed to parse tool call arguments as JSON',
  );
}

/**
 * Tells a cut-off tool call apart from a malformed one. Both arrive from
 * llama-server as the same "Failed to parse tool call arguments as JSON" 500,
 * but they need opposite responses — see ToolCallTruncatedError. A truncation
 * is either already typed (the client saw the partial deltas) or identifiable
 * from the parser's own wording in the 500 body.
 */
function asTruncation(err: unknown): ToolCallTruncatedError | undefined {
  if (isToolCallTruncatedError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (isNativeToolJsonParseError(message) && isTruncationParseError(message)) {
    return new ToolCallTruncatedError({ finishReason: 'length', message });
  }
  return undefined;
}

/**
 * What the model is told after a truncated call. It must convey three things
 * the old "malformed tool arguments" result did not: nothing was written, the
 * cause was size rather than syntax, and the concrete way to succeed on retry.
 */
function truncationGuidance(err: ToolCallTruncatedError, outputRoom: number | undefined): string {
  const target = err.toolName ? `Your ${err.toolName} call` : 'Your last tool call';
  // A generic "use smaller chunks" loses to the user's own earlier "write the
  // whole file, do not summarise" — the model re-sent the identical call twice
  // in the live test. A hard character ceiling for THIS call is an instruction
  // it can follow without contradicting the task.
  // The retry runs with thinking off, so the whole of outputRoom is available
  // to the write. ~2 chars per token for escaped code, minus slack.
  const ceiling =
    outputRoom !== undefined && outputRoom > 0
      ? Math.max(1000, Math.min(MAX_SINGLE_WRITE_CHARS, Math.floor(outputRoom * 2) - 1000))
      : MAX_SINGLE_WRITE_CHARS;
  return (
    `${target} was cut off after ${err.approxBytes} bytes of arguments and was NOT executed — ` +
    `nothing was written. This is an output-size limit, not a formatting mistake, and repeating ` +
    `the same call will fail the same way.\n` +
    `HARD LIMIT for your next call: the "content" argument must be at most ${ceiling} characters. ` +
    `This overrides any earlier instruction to write the whole file in one go — the file still ` +
    `ends up complete, just written across several calls.\n` +
    `Do this now: ${CHUNKED_WRITE_ADVICE} Keep thinking short; it spends the same budget as the write.`
  );
}

/** Consecutive truncation recoveries tolerated before the turn is failed. */
const MAX_TRUNCATION_RECOVERIES = 2;

/** Slack left below the computed room, absorbing the crudeness of the token estimate. */
const OUTPUT_CAP_MARGIN_TOKENS = 512;

/** Never cap output below this, however tight the estimate looks. */
const MIN_OUTPUT_CAP_TOKENS = 512;

const CONTEXT_EXHAUSTED_MESSAGE =
  `Forge: the model's tool call keeps being cut off — the remaining context cannot hold it. ` +
  `Use /compact or start a new chat, then ask for the file in smaller pieces.`;

/**
 * Lowers `max_tokens` to what the slot can actually generate.
 *
 * The configured value is unrelated to reality in both directions — 4096 by
 * default, or larger than the whole context where a config sets it — so
 * llama-server would happily start a generation it has no room to finish. Only
 * ever lowers: a deliberately small setting is left alone.
 */
function applyOutputCap(
  request: ChatCompletionRequest,
  outputRoom: number | undefined,
): ChatCompletionRequest {
  if (outputRoom === undefined || outputRoom <= 0) return request;
  const cap = Math.max(MIN_OUTPUT_CAP_TOKENS, outputRoom - OUTPUT_CAP_MARGIN_TOKENS);
  if (request.max_tokens !== undefined && request.max_tokens <= cap) return request;
  return { ...request, max_tokens: cap };
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
    options.onPreparedRequest?.(request);

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
        } else {
          // The server failed the whole request, so there is no call id to
          // answer — a plain user-role nudge is the portable alternative.
          options.messages.push({ role: 'user', content: guidance });
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
      const beforeDispatch = options.messages.length;
      await options.dispatchToolCalls(calls, options.messages);
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
      finalText = assistantContent;
    }
    options.onDone?.(streamed.finishReason);
    return {
      finishReason: streamed.finishReason,
      finalText,
      rounds: round + 1,
      repeatedCall: false,
    };
  }
  throw new Error(`Forge: agent exceeded maximum tool rounds (${options.maxRounds}).`);
}
