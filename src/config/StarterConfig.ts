import type { ModelSuggestion } from '../backend/ModelHeuristics';
import { AgentBusConfigSchema } from './agentBusSchema';
import { RemoteConfigSchema } from './remoteSchema';
import type { ForgeConfig } from './types';

export interface StarterLlamaCppModel {
  ggufPath: string;
  modelName: string;
  suggestion: ModelSuggestion;
}

// A coding agent needs to run builds and tests, so a new install can; every
// such action still goes through the confirmation gate. Browser, desktop,
// fetch and delegation are on for a new install (owner's call, 0.17.5): each
// new browser origin is still approved per session, and desktop control of VS
// Code itself stays off (`allow_vscode`). Search needs a key and stays off, as
// do the visible terminal and shell scripts. Existing configs are unchanged:
// an absent key still means off.
// Chat-to-chat new-chat and steer actions also stay off until opted in.
// `approval_timeout_minutes` stays absent so unanswered approvals wait forever
// unless the owner opts in through config.yaml.
const DEFAULT_PERMISSIONS: NonNullable<ForgeConfig['permissions']> = {
  fs: { read: true, write: true, delete: true },
  net: { search: false, fetch: true },
  exec: { headless: true },
  git: { read: true, write: true },
  agents: { delegate: true },
  chats: { new_chat: false, steer: false },
  browser: { enabled: true },
  desktop: { enabled: true },
};

/**
 * Remote's schema defaults, with no transport enabled. `wake_relay` has no
 * default and may parse to `undefined`, which the hand-written config type does
 * not admit under exactOptionalPropertyTypes, so it is kept only when set.
 */
function starterRemote(): NonNullable<ForgeConfig['remote']> {
  const { wake_relay, ...remote } = RemoteConfigSchema.unwrap().parse({ enabled: true });
  return wake_relay ? { ...remote, wake_relay } : remote;
}

/**
 * Settings every starter carries: the tested agent setup, not just a model
 * list. Auto-compaction and the auto-created FORGE.md are off in the schema,
 * so a config without these lines silently runs without either. The 200K
 * output cap is only a ceiling — each request is clamped to the room the
 * context leaves.
 */
const STARTER_AGENT_SETTINGS = {
  agent_links: { open_panel: 'every_ask', panel_live_timeout_ms: 20_000 },
  // On for a new install (owner's call, 0.17.5). The config types are the
  // parsed shapes, so agent_bus and remote take their schema defaults here and
  // the starter file spells them out. Remote is enabled with no transport:
  // Telegram/WhatsApp still need a bot token and pairing. Jobs with none
  // defined are inert.
  control_server: { enabled: true },
  agent_bus: AgentBusConfigSchema.unwrap().parse({ enabled: true }),
  remote: starterRemote(),
  jobs: { enabled: true, allowed_hosts: [], max_concurrent: 2, allow_cli_agents: true },
  forge_instructions: { auto_create: true },
  auto_compact: { enabled: true, at: 0.85, resume: true },
  defaults: {
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
