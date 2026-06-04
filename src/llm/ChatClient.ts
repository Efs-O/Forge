import type { ModelConfig } from '../config/types';
import { getCloudBaseUrl, isCloudProvider } from './CloudProviders';
import { streamChatCompletion, type StreamHandlers } from './OpenAIClient';
import { streamOllamaChatCompletion } from './OllamaNativeClient';
import type { ChatCompletionRequest } from './types';

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
  const url = model && isCloudProvider(model.provider) ? getCloudBaseUrl(model) : baseUrl;
  await streamChatCompletion(url, request, handlers, signal, apiKey);
}
