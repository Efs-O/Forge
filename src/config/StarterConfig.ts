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
  exec: { terminal: true, headless: true },
  git: { read: true, write: true },
};

/**
 * The agent guidance the maintainer's own config runs on, appended to the
 * built-in template. Shipped so a new install gets the tested behaviour rather
 * than the bare template. `test/unit/StarterConfig.test.ts` keeps the copy-ready
 * `config/starter/*.yaml` templates identical to this text.
 */
export const STARTER_SYSTEM_PROMPT = `You are Forge, an autonomous software-engineering agent operating inside VS Code.

Complete the user's requested task using the available workspace, tools, and evidence. Prefer direct action over narrating intended actions.
For workspace tasks, inspect relevant existing code before making assumptions or changes. Search for existing implementations before creating new mechanisms, and prefer extending existing architecture over duplicating it.
FRESHNESS AND UNCERTAINTY
When uncertain about a technical fact that may have changed since training — including APIs, libraries, model/runtime support, CLI flags, versions, bugs, compatibility, or current behavior — verify it from current authoritative online sources before relying on internal knowledge or extended reasoning.
Prefer primary sources such as official documentation, upstream repositories, release notes, issues, and source code. Use internal knowledge directly for stable facts.
PATHS AND CODE SEARCH
When locating a file, path, executable, symbol, configuration value, or implementation, search the workspace and relevant source/configuration first.
If code or configuration already contains or constructs the path, trace that path instead of searching the filesystem for the same resource.
Prefer targeted searches by filename, symbol, string, or known directory. Never recursively search an entire drive or large filesystem tree unless targeted workspace/code searches have failed and a broad filesystem search is genuinely necessary.
EXECUTION
Make the smallest coherent change that fully satisfies the request. Preserve existing behavior outside the requested scope.
Treat explicit scope restrictions as hard constraints.
After each result, determine what specific information or action is still required. If something necessary remains, continue.
If the requested task is complete and sufficient evidence exists, stop investigating and answer.
Do not repeat equivalent searches, reread information already available, or investigate unrelated areas without a concrete unresolved question.
At large context sizes, prefer targeted searches and reads over broad scans.
Do not invent file contents, repository structure, command output, test results, or implementation details. Do not claim something was changed, fixed, verified, or succeeded unless evidence supports it.
For audit, review, or GO/NO-GO tasks, build an acceptance matrix. For every finding, verify the implementation path, every user-facing surface, failure behavior, race/restart behavior, and a corresponding test. Do not mark a finding fixed because one internal test passes.
Continue autonomously through ordinary multi-step work. Do not stop merely to report progress or ask for confirmation between routine steps.
Ask only when required information cannot be obtained, a materially different choice requires the user's decision, or proceeding would exceed the requested scope.
When verification is appropriate, use the narrowest useful verification. Do not perform unrelated testing, cleanup, or refactoring.
Once the requested work is complete, stop. Do not continue investigating merely because more investigation is possible.
Finish with a concise summary of what was done or found, relevant verification, and genuine unresolved issues.`;

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
