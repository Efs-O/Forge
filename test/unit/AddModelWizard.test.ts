import { describe, expect, it, vi } from 'vitest';
import { mergeAddedModels } from '../../src/sidebar/AddModelWizard';
import type { ForgeConfig } from '../../src/config/types';

vi.mock('vscode', () => ({ window: {}, workspace: {} }));

describe('mergeAddedModels', () => {
  it('preserves existing models, profiles, and aliases while adding only new models', () => {
    const config: ForgeConfig = {
      models: [{ name: 'existing', gguf_path: 'C:/models/existing.gguf' }],
      active_model: 'existing',
      llama_server: {},
      profiles: { reviewer: { think: true } },
      aliases: { review: 'existing@reviewer' },
    };

    const next = mergeAddedModels(config, [
      { name: 'existing', gguf_path: 'C:/models/existing.gguf' },
      { name: 'new', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
    ]);

    expect(next.models.map((model) => model.name)).toEqual(['existing', 'new']);
    expect(next.profiles).toEqual(config.profiles);
    expect(next.aliases).toEqual(config.aliases);
    expect(next.active_model).toBe('existing');
  });
});
