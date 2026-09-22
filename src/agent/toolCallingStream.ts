import { streamModelChatCompletion } from '../llm/ChatClient';
import type { ChatCompletionRequest, ToolCall } from '../llm/types';
import { stripHtmlDocumentBoilerplateFromFullText } from '../llm/HtmlDocumentBoilerplateStripper';
import { stripThinkingFromFullText } from '../llm/ThinkingChannelStripper';
import { stripStructuredOutputFromFullText } from '../tools/StructuredOutputParser';
import type { ToolCallingLoopOptions } from './ToolCallingLoop';

export function sanitizeText(text: string, stripThinking: boolean): string {
  const withoutThinking = stripThinking ? stripThinkingFromFullText(text) : text;
  const withoutStructured = stripStructuredOutputFromFullText(withoutThinking);
  return stripHtmlDocumentBoilerplateFromFullText(withoutStructured);
}

export async function streamOnce(
  options: ToolCallingLoopOptions,
  request: ChatCompletionRequest,
  onToken: (token: string) => void,
  onReasoning: (token: string) => void,
): Promise<{ finishReason: string | null; toolCalls: ToolCall[] | null }> {
  const baseUrl = await options.resolveBaseUrl();
  return new Promise((resolve, reject) => {
    let capturedToolCalls: ToolCall[] | null = null;
    void streamModelChatCompletion(
      baseUrl,
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
