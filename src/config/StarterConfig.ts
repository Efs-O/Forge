import type { ModelSuggestion } from '../backend/ModelHeuristics';
import type { ForgeConfig } from './types';

export interface StarterLlamaCppModel {
  ggufPath: string;
  modelName: string;
  suggestion: ModelSuggestion;
}

const DEFAULT_PERMISSIONS: NonNullable<ForgeConfig['permissions']> = {
  fs: { read: true, write: true, delete: false },
  net: { search: false, fetch: false },
  exec: { terminal: false, headless: false },
  git: { read: true, write: false },
};

/** Builds a schema-valid starter config for selected direct llama.cpp models. */
export function makeLlamaCppStarterConfig(
  models: StarterLlamaCppModel[],
  binary: string,
): ForgeConfig {
  const first = models[0];
  if (!first) throw new Error('At least one llama.cpp model is required.');
  return {
    models: models.map(({ ggufPath, modelName, suggestion }) => ({
      name: modelName,
      provider: 'llama.cpp',
      gguf_path: ggufPath,
      spawn: {
        num_ctx: suggestion.numCtx,
        n_batch: suggestion.nBatch,
        flash_attn: suggestion.flashAttn,
      },
    })),
    active_model: first.modelName,
    llama_server: {
      binary,
      // 999, never -1: on current llama.cpp -1 means auto-fit, a silent CPU
      // spill (see LlamaServerArgs.ts). A model that does not fit now fails to
      // load with a message naming this setting.
      n_gpu_layers: 999,
      flash_attn_default: true,
      default_num_ctx: first.suggestion.numCtx,
    },
    permissions: DEFAULT_PERMISSIONS,
  };
}

/** Builds a schema-valid starter config for models exposed by an Ollama daemon. */
export function makeOllamaStarterConfig(endpoint: string, modelNames: string[]): ForgeConfig {
  const first = modelNames[0];
  if (!first) throw new Error('At least one Ollama model is required.');
  return {
    models: modelNames.map((name) => ({
      name,
      provider: 'ollama',
      endpoint,
      num_ctx: 32768,
    })),
    active_model: first,
    llama_server: {},
    permissions: DEFAULT_PERMISSIONS,
  };
}

/** CLI agents the wizard found on PATH. */
export interface FoundCliAgents {
  claude: boolean;
  codex: boolean;
}

/**
 * Adds a `provider: cli` entry for each CLI agent found. The `cli` value is the
 * bare command name, never the resolved path: `resolveCliExecutable` looks it up
 * on PATH at spawn, so the entry survives a CLI upgrade and another username.
 * `active_model` is left alone — a local model stays the default chat.
 */
export function withCliAgents(config: ForgeConfig, found: FoundCliAgents): ForgeConfig {
  const agents: ForgeConfig['models'] = [];
  if (found.claude) agents.push({ name: 'claude-code', provider: 'cli', cli: 'claude' });
  if (found.codex) agents.push({ name: 'codex', provider: 'cli', cli: 'codex' });
  return agents.length ? { ...config, models: [...config.models, ...agents] } : config;
}
