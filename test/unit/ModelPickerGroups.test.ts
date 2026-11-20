import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import {
  compareModelPickerEntries,
  describeModelPickerModel,
  MODEL_PICKER_GROUP_ORDER,
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
    [
      {
        provider: 'openai-compatible',
        endpoint: 'http://100.64.1.20:8081/v1',
        remote_start: { starter: 'http://100.64.1.20:8081', model: 'strata-flashnext-iq3_s' },
      },
      'Desktop',
    ],
    [
      {
        provider: 'openai-compatible',
        endpoint: 'http://100.64.1.20:8081/v1',
      },
      'Other OpenAI-compatible',
    ],
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

describe('the Desktop group (models served by the desktop)', () => {
  /** The laptop's entry for a model the desktop starts and serves. */
  const remoteStart = {
    name: 'strata-flashnext-iq3_s',
    provider: 'openai-compatible',
    endpoint: 'http://100.64.1.20:8081/v1',
    remote_start: { starter: 'http://100.64.1.20:8081', model: 'strata-flashnext-iq3_s' },
  } as const;

  it('groups a remote_start entry as Desktop', () => {
    expect(modelPickerGroup(model(remoteStart))).toBe('Desktop');
    expect(describeModelPickerModel(model(remoteStart))).toEqual({
      name: 'strata-flashnext-iq3_s',
      group: 'Desktop',
    });
  });

  it('leaves the very same entry without remote_start where it was', () => {
    const { remote_start: remote, ...without } = remoteStart;
    expect(remote).toBeDefined();
    expect(modelPickerGroup(model(without))).toBe('Other OpenAI-compatible');
  });

  it('puts Desktop in the order right after Ollama Cloud', () => {
    expect(MODEL_PICKER_GROUP_ORDER.indexOf('Desktop')).toBe(
      MODEL_PICKER_GROUP_ORDER.indexOf('Ollama Cloud') + 1,
    );
    const ordered = modelPickerSelectionEntries([
      { name: 'grok', group: 'OpenRouter' },
      { name: 'strata', group: 'Desktop' },
      { name: 'qwen:cloud', group: 'Ollama Cloud' },
      { name: 'local', group: 'Local — llama.cpp' },
    ]);
    expect(ordered.map((entry) => entry.group)).toEqual([
      'Local — llama.cpp',
      'Ollama Cloud',
      'Desktop',
      'OpenRouter',
    ]);
  });
});
