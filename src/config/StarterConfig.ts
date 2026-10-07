import type { ModelSuggestion } from '../backend/ModelHeuristics';
import type { ForgeConfig } from './types';

export interface StarterLlamaCppModel {
  ggufPath: string;
  modelName: string;
  suggestion: ModelSuggestion;
}

// A coding agent needs to run builds and tests, so a new install can; every
// such action still goes through the confirmation gate. Search, fetch,
// browser, desktop, shell scripts and delegation stay opt-in.
const DEFAULT_PERMISSIONS: NonNullable<ForgeConfig['permissions']> = {
  fs: { read: true, write: true, delete: true },
  net: { search: false, fetch: false },
  exec: { headless: true },
  git: { read: true, write: true },
};

/**
 * Agent guidance appended to the built-in template. Kept short: the 25-line
 * version it replaced roughly doubled decode time on the harness bench
 * (docs/plans/HARNESS_COMPARISON_PLAN.md) without changing results. `test/unit/StarterConfig.test.ts` keeps the copy-ready
 * `config/starter/*.yaml` templates identical to this text.
 */
export const STARTER_SYSTEM_PROMPT = `Be brief. Think only as long as the next action needs; do not re-verify what a tool result already showed.
Batch independent tool calls in one response. Search many files in one command, not one call per file.
When the task is done and the evidence is in hand, stop and give a short answer.
Before you call a change done, run the narrowest check that proves it (the relevant test, build or a re-read of the edited lines); report what you ran and what it showed.
Do not claim anything you have not seen in a tool result.`;

/**
 * Settings every starter carries: the tested agent setup, not just a model
 * list. Auto-compaction and the auto-created FORGE.md are off in the schema,
 * so a config without these lines silently runs without either. The 200K
 * output cap is only a ceiling — each request is clamped to the room the
 * context leaves.
 */
const STARTER_AGENT_SETTINGS = {
  forge_instructions: { auto_create: true },
  auto_compact: { enabled: true, at: 0.85, resume: true },
  defaults: {
    system_prompt: STARTER_SYSTEM_PROMPT,
    sampling: { temperature: 0.6, top_p: 0.95, max_tokens: 200000 },
  },
} satisfies Partial<ForgeConfig>;

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
      // The family's recommended sampling; max_tokens comes from defaults.
      sampling: {
        temperature: suggestion.temperature,
        top_p: suggestion.topP,
        top_k: suggestion.topK,
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
    ...STARTER_AGENT_SETTINGS,
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
    ...STARTER_AGENT_SETTINGS,
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
