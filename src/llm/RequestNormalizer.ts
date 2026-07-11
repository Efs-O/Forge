import type { ModelConfig } from '../config/types';
import type { ChatCompletionRequest } from './types';

function ollamaReasoningEffort(
  model: ModelConfig,
): ChatCompletionRequest['reasoning_effort'] | undefined {
  if (model.think === false) return 'none';
  if (model.think === true) return model.reasoning_effort ?? 'medium';
  return model.reasoning_effort;
}

export function normalizeRequestForModel(
  request: ChatCompletionRequest,
  model: ModelConfig | undefined,
): ChatCompletionRequest {
  if (!model || (model.provider ?? 'llama.cpp') !== 'ollama') {
    return request;
  }

  const normalized = {
    model: request.model,
    messages: request.messages,
    stream: request.stream,
    temperature: request.temperature,
    top_p: request.top_p,
    top_k: request.top_k,
    min_p: request.min_p,
    max_tokens: request.max_tokens,
    seed: request.seed,
    frequency_penalty: request.frequency_penalty,
    presence_penalty: request.presence_penalty,
    repetition_penalty: request.repetition_penalty,
    repeat_penalty: request.repeat_penalty,
    repeat_last_n: request.repeat_last_n,
    reasoning_effort: ollamaReasoningEffort(model),
    ...(request.stop ? { stop: request.stop } : {}),
    ...(request.tools ? { tools: request.tools } : {}),
  };

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined),
  ) as unknown as ChatCompletionRequest;
}
