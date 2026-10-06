import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ForgeConfigSchema } from '../../src/config/schema';
import {
  makeLlamaCppStarterConfig,
  makeOllamaStarterConfig,
  STARTER_SYSTEM_PROMPT,
  withCliAgents,
} from '../../src/config/StarterConfig';

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

  const suggestion = {
    family: 'unknown' as const,
    suggestedName: 'a',
    numCtx: 16384,
    nBatch: 512,
    flashAttn: true,
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
  };
  const llama = () =>
    makeLlamaCppStarterConfig(
      [{ ggufPath: 'C:/models/a.gguf', modelName: 'a', suggestion }],
      'llama-server',
    );

  it('offloads every layer (999), never auto-fit (-1)', () => {
    // -1 is auto-fit on current llama.cpp: a silent CPU spill (LlamaServerArgs.ts).
    expect(llama().llama_server.n_gpu_layers).toBe(999);
  });

  it('adds the CLI agents found on PATH, by bare name', () => {
    const config = withCliAgents(llama(), { claude: true, codex: true });
    const cli = config.models.filter((m) => m.provider === 'cli');
    expect(cli).toEqual([
      { name: 'claude-code', provider: 'cli', cli: 'claude' },
      { name: 'codex', provider: 'cli', cli: 'codex' },
    ]);
    // A bare name resolves on PATH at spawn; an absolute path breaks on upgrade.
    for (const model of cli) expect(model.cli).not.toMatch(/[\\/]/);
    expect(config.active_model).toBe('a');
    expect(ForgeConfigSchema.parse(config).models).toHaveLength(3);
  });

  it('adds only what was found, and nothing when neither is installed', () => {
    const names = (found: { claude: boolean; codex: boolean }) =>
      withCliAgents(makeOllamaStarterConfig('http://127.0.0.1:11434', ['m']), found).models.map(
        (m) => m.name,
      );
    expect(names({ claude: false, codex: true })).toEqual(['m', 'codex']);
    expect(names({ claude: false, codex: false })).toEqual(['m']);
  });

  // The wizard and the copy-ready templates are two routes to one setup; a
  // new install must get the tested agent settings whichever route it takes.
  it('gives every starter, wizard or template, the same tested agent setup', () => {
    const wizard = makeOllamaStarterConfig('http://127.0.0.1:11434', ['m']);
    const pick = (c: Record<string, unknown>) => ({
      permissions: c['permissions'],
      forge_instructions: c['forge_instructions'],
      auto_compact: c['auto_compact'],
      defaults: c['defaults'],
    });
    expect(wizard.auto_compact).toEqual({ enabled: true, at: 0.85, resume: true });
    expect(wizard.forge_instructions).toEqual({ auto_create: true });
    expect(wizard.defaults?.system_prompt).toBe(STARTER_SYSTEM_PROMPT);
    const dir = path.join(__dirname, '../../config/starter');
    for (const file of ['llama-cpp.yaml', 'ollama.yaml', 'openai-compatible.yaml']) {
      const template = parseYaml(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<
        string,
        unknown
      >;
      const parsed = pick(template);
      // A block scalar keeps one trailing newline.
      const defaults = parsed.defaults as { system_prompt: string };
      defaults.system_prompt = defaults.system_prompt.trimEnd();
      expect(parsed, file).toEqual(pick(wizard as unknown as Record<string, unknown>));
    }
  });

  it('gives llama.cpp models their family sampling on top of the defaults', () => {
    const config = makeLlamaCppStarterConfig(
      [
        {
          ggufPath: 'C:/models/q.gguf',
          modelName: 'q',
          suggestion: {
            family: 'qwen3',
            suggestedName: 'q',
            numCtx: 98304,
            nBatch: 1024,
            flashAttn: true,
            temperature: 0.6,
            topP: 0.95,
            topK: 20,
          },
        },
      ],
      'C:/llama/llama-server.exe',
    );
    expect(config.models[0]?.sampling).toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20 });
    expect(ForgeConfigSchema.parse(config).defaults?.sampling?.max_tokens).toBe(200000);
  });
});
