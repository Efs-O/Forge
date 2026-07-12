import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { makeLlamaCppStarterConfig, makeOllamaStarterConfig } from '../../src/config/StarterConfig';

describe('starter config generation', () => {
  it('generates a schema-valid multi-model llama.cpp config', () => {
    const config = makeLlamaCppStarterConfig(
      [
        {
          ggufPath: 'C:/models/a.gguf',
          modelName: 'a',
          suggestion: {
            family: 'unknown',
            suggestedName: 'a',
            numCtx: 16384,
            nBatch: 512,
            flashAttn: true,
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
          },
        },
        {
          ggufPath: 'C:/models/b.gguf',
          modelName: 'b',
          suggestion: {
            family: 'unknown',
            suggestedName: 'b',
            numCtx: 32768,
            nBatch: 1024,
            flashAttn: false,
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
          },
        },
      ],
      'llama-server',
    );
    expect(ForgeConfigSchema.parse(config).models).toHaveLength(2);
    expect(config.active_model).toBe('a');
  });

  it('generates a schema-valid multi-model Ollama config', () => {
    const config = makeOllamaStarterConfig('http://127.0.0.1:11434', ['qwen', 'llama']);
    expect(ForgeConfigSchema.parse(config).models).toHaveLength(2);
    expect(config.models[0]?.provider).toBe('ollama');
  });
});
