import { describe, it, expect } from 'vitest';
import { getProviderDisplayName } from '../../src/llm/CloudProviders';
import type { ModelConfig } from '../../src/config/types';

const model = (overrides: Partial<ModelConfig>): ModelConfig =>
  ({ name: 'm', ...overrides }) as ModelConfig;

describe('getProviderDisplayName', () => {
  it('derives the name from the endpoint host for openai-compatible', () => {
    expect(
      getProviderDisplayName(model({ provider: 'openai-compatible', endpoint: 'https://api.cerebras.ai' })),
    ).toBe('cerebras');
    expect(
      getProviderDisplayName(model({ provider: 'openai-compatible', endpoint: 'https://www.groq.com/v1' })),
    ).toBe('groq');
  });

  it('falls back to the generic label when the endpoint is missing or invalid', () => {
    expect(getProviderDisplayName(model({ provider: 'openai-compatible' }))).toBe('OpenAI-compatible');
    expect(
      getProviderDisplayName(model({ provider: 'openai-compatible', endpoint: 'not-a-url' })),
    ).toBe('OpenAI-compatible');
  });

  it('uses the provider label for named cloud providers', () => {
    expect(getProviderDisplayName(model({ provider: 'xai' }))).toBe('xAI');
    expect(getProviderDisplayName(model({ provider: 'openrouter' }))).toBe('OpenRouter');
  });

  it('names local providers directly', () => {
    expect(getProviderDisplayName(model({ provider: 'ollama' }))).toBe('ollama');
    expect(getProviderDisplayName(model({}))).toBe('llama.cpp');
  });
});
