import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import { compareModelPickerEntries, modelPickerGroup } from '../../src/sidebar/ModelPickerGroups';

function model(overrides: Partial<ModelConfig>): ModelConfig {
  return { name: 'model', ...overrides };
}

describe('modelPickerGroup', () => {
  it.each([
    [{}, 'Local — llama.cpp'],
    [{ provider: 'ollama' }, 'Local — Ollama'],
    [{ provider: 'ollama', name: 'qwen:cloud' }, 'Ollama Cloud'],
    [{ provider: 'xai' }, 'xAI / Grok'],
    [{ provider: 'openai-compatible', endpoint: 'https://api.cerebras.ai/v1' }, 'Cerebras'],
    [{ provider: 'openai' }, 'OpenAI'],
    [{ provider: 'openrouter' }, 'OpenRouter'],
    [{ provider: 'openai-compatible', endpoint: 'https://api.groq.com/v1' }, 'Other OpenAI-compatible'],
    [{ provider: 'cli' }, 'CLI agents'],
  ] as const)('puts %o in %s', (input, expected) => {
    expect(modelPickerGroup(model(input))).toBe(expected);
  });
});

describe('compareModelPickerEntries', () => {
  it('sorts case-insensitively by name', () => {
    expect([{ name: 'zeta' }, { name: 'Alpha' }, { name: 'beta' }].sort(compareModelPickerEntries)).toEqual([
      { name: 'Alpha' },
      { name: 'beta' },
      { name: 'zeta' },
    ]);
  });
});
