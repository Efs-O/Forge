import type { ModelConfig } from '../config/types';
import { streamChatCompletion, type StreamHandlers } from './OpenAIClient';
import { streamOllamaChatCompletion } from './OllamaNativeClient';
import type { ChatCompletionRequest } from './types';

const XAI_BASE_URL = 'https://api.x.ai';
// OpenRouter is OpenAI-compatible; OpenAIClient appends "/v1/chat/completions".
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

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
  const url =
    model?.provider === 'xai'
      ? XAI_BASE_URL
      : model?.provider === 'openrouter'
        ? OPENROUTER_BASE_URL
        : baseUrl;
  await streamChatCompletion(url, request, handlers, signal, apiKey);
}
