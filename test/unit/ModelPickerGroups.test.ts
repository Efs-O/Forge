import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import {
  compareModelPickerEntries,
  describeModelPickerModel,
  modelPickerGroup,
  modelPickerSelectionEntries,
} from '../../src/sidebar/ModelPickerGroups';

function model(overrides: Partial<ModelConfig>): ModelConfig {
  return { name: 'model', ...overrides };
}

describe('modelPickerGroup', () => {
  it.each([
    [{}, 'Local — llama.cpp'],
    [{ provider: 'ollama' }, 'Ollama Local'],
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

describe('display_name', () => {
  it('carries display_name as the label and keeps name as the id', () => {
    expect(describeModelPickerModel(model({ name: 'qwen38-27b-q4', display_name: 'Qwen fast' }))).toEqual({
      name: 'qwen38-27b-q4',
      displayName: 'Qwen fast',
      group: 'Local — llama.cpp',
    });
    expect(describeModelPickerModel(model({ name: 'plain' }))).not.toHaveProperty('displayName');
  });

  it('sorts by the displayed label and labels profile variants', () => {
    const entries = modelPickerSelectionEntries([
      { name: 'aaa', displayName: 'Zed', group: 'Local — llama.cpp', profiles: ['audit'] },
      { name: 'zzz', displayName: 'Alpha', group: 'Local — llama.cpp' },
    ]);
    expect(entries.map((entry) => [entry.name, entry.displayName])).toEqual([
      ['zzz', 'Alpha'],
      ['aaa', 'Zed'],
      ['aaa@audit', 'Zed@audit'],
    ]);
  });
});
