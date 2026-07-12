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
      n_gpu_layers: -1,
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
