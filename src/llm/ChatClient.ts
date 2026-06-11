import type { ModelConfig } from '../config/types';
import { streamChatCompletion, type StreamHandlers } from './OpenAIClient';
import { streamOllamaChatCompletion } from './OllamaNativeClient';
import type { ChatCompletionRequest } from './types';

/**
 * Routes a streaming chat request to the right client for the model's
 * provider. `baseUrl` is authoritative — for cloud providers the caller
 * resolves it via getCloudBaseUrl (AgentLoop owns that).
 */
export async function streamModelChatCompletion(
  baseUrl: string,
  request: ChatCompletionRequest,
  model: ModelConfig | undefined,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  apiKey?: string,
): Promise<void> {
  if (model?.provider === 'ollama') {
    await streamOllamaChatCompletion(baseUrl, request, model, handlers, signal);
    return;
  }
  await streamChatCompletion(baseUrl, request, handlers, signal, apiKey);
}
