import { describe, expect, it } from 'vitest';
import {
  classifyModelRoute,
  isCloudModelRoute,
  isOllamaCloudModel,
} from '../../src/llm/ModelRouteClassifier';

describe('ModelRouteClassifier', () => {
  it('distinguishes direct, local Ollama, Ollama cloud, and direct cloud routes', () => {
    expect(classifyModelRoute({ name: 'gguf', provider: 'llama.cpp' })).toBe('local-llama');
    expect(classifyModelRoute({ name: 'local', provider: 'ollama', model: 'qwen:7b' })).toBe(
      'local-ollama',
    );
    expect(classifyModelRoute({ name: 'qwen:cloud', provider: 'ollama' })).toBe(
      'ollama-cloud',
    );
    expect(classifyModelRoute({ name: 'api', provider: 'openai', model: 'gpt' })).toBe(
      'direct-cloud',
    );
  });

  it('uses one Ollama cloud predicate and one cloud-route predicate', () => {
    expect(isOllamaCloudModel({ name: 'x:cloud', provider: 'ollama' })).toBe(true);
    expect(isOllamaCloudModel({ name: 'x:latest', provider: 'ollama' })).toBe(false);
    expect(isCloudModelRoute('ollama-cloud')).toBe(true);
    expect(isCloudModelRoute('direct-cloud')).toBe(true);
    expect(isCloudModelRoute('local-ollama')).toBe(false);
  });
});
