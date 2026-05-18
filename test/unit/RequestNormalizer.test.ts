import { describe, expect, it } from 'vitest';
import { normalizeRequestForModel } from '../../src/llm/RequestNormalizer';
import type { ModelConfig } from '../../src/config/types';
import type { ChatCompletionRequest } from '../../src/llm/types';

const baseRequest: ChatCompletionRequest = {
  model: 'demo',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
  temperature: 0.6,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  max_tokens: 1000,
  seed: 0,
  repeat_last_n: 64,
  stop: '<end_of_turn>',
  chat_template_kwargs: { enable_thinking: true },
  tools: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object' },
      },
    },
  ],
};

describe('normalizeRequestForModel', () => {
  it('preserves Ollama-native sampling fields and maps thinking controls', () => {
    const model: ModelConfig = {
      name: 'gemma4:26b',
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      think: false,
    };

    const normalized = normalizeRequestForModel(baseRequest, model);
    expect(normalized.top_k).toBe(40);
    expect(normalized.min_p).toBe(0.05);
    expect(normalized.chat_template_kwargs).toBeUndefined();
    expect(normalized.reasoning_effort).toBe('none');
    expect(normalized.repeat_last_n).toBe(64);
    expect(normalized.seed).toBe(0);
    expect(normalized.stop).toBe('<end_of_turn>');
    expect(normalized.tools).toHaveLength(1);
  });

  it('leaves llama.cpp requests unchanged', () => {
    const model: ModelConfig = {
      name: 'local-gguf',
      provider: 'llama.cpp',
      gguf_path: 'C:/models/local.gguf',
      think: true,
    };

    expect(normalizeRequestForModel(baseRequest, model)).toEqual(baseRequest);
  });
});
