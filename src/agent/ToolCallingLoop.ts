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
import { stripThinkingFromFullText } from '../llm/ThinkingChannelStripper';
import { stripHtmlDocumentBoilerplateFromFullText } from '../llm/HtmlDocumentBoilerplateStripper';

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
  let lastToolSignature: string | null = null;
  let finalText = '';

  for (let round = 0; round < options.maxRounds; round++) {
    options.signal.throwIfAborted();
    const prepared = options.prepareMessages
      ? options.prepareMessages([...options.messages])
      : [...options.messages];
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
      ...(options.canUseThinkingKwargs && options.model.think !== undefined
        ? {
            chat_template_kwargs: {
              ...(options.model.sampling?.preserve_thinking !== undefined
                ? { preserve_thinking: options.model.sampling.preserve_thinking }
                : {}),
              enable_thinking: options.model.think,
            },
          }
        : {}),
    };
    const merged = mergeSampling(base, options.model, {
      allowPreserveThinking: options.canUseThinkingKwargs ?? false,
    });
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
      const signature = calls
        .map((call) => `${call.function.name}:${call.function.arguments}`)
        .join('|');
      if (signature === lastToolSignature) {
        options.onRepeatedCall?.();
        return {
          finishReason: streamed.finishReason,
          finalText,
          rounds: round + 1,
          repeatedCall: true,
        };
      }
      lastToolSignature = signature;
      options.failureTracker?.reset();
      options.messages.push({ role: 'assistant', content: null, tool_calls: calls });
      await options.dispatchToolCalls(calls, options.messages);
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
