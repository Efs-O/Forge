import type { ModelConfig } from '../config/types';
import { streamChatCompletion, type StreamHandlers } from './OpenAIClient';
import { streamOllamaChatCompletion } from './OllamaNativeClient';
import type { ChatCompletionRequest } from './types';

/** `provider: cli` models use the dedicated sidebar CLI-agent path. Reaching
 * this HTTP router is an internal routing error. */
export const CLI_MODEL_CHAT_ERROR =
  'Forge internal error: a CLI agent was routed through the HTTP chat client.';

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
  if (model?.provider === 'cli') {
    handlers.onError(new Error(CLI_MODEL_CHAT_ERROR));
    return;
  }
  if (model?.provider === 'ollama') {
    await streamOllamaChatCompletion(baseUrl, request, model, handlers, signal);
    return;
  }
  await streamChatCompletion(baseUrl, request, handlers, signal, apiKey);
}
