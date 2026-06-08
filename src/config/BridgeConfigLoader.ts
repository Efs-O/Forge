import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { ModelConfig } from './types';

interface BridgeModelEntry {
  provider?: unknown;
  gguf_path?: unknown;
  mmproj_path?: unknown;
  endpoint?: unknown;
  n_gpu_layers?: unknown;
  num_ctx?: unknown;
  n_batch?: unknown;
  type_k?: unknown;
  type_v?: unknown;
  flash_attn?: unknown;
  extra_llama_server_args?: unknown;
  sampling?: unknown;
  capabilities?: unknown;
  strip_tools?: unknown;
  system_prompt?: unknown;
  think?: unknown;
  reasoning_effort?: unknown;
  strip_thinking_channels?: unknown;
  api_key_secret?: unknown;
  n_parallel?: unknown;
  // v2 fields
  runtime?: unknown;
  prompt?: unknown;
}

interface RuntimeDef {
  n_parallel?: number;
  num_ctx?: number;
}

interface RuntimeDefaultsDef {
  n_gpu_layers?: number | undefined;
  n_batch?: number | undefined;
  type_k?: number | undefined;
  type_v?: number | undefined;
  flash_attn?: boolean | undefined;
}

const REASONING_EFFORTS = new Set(['high', 'medium', 'low', 'none']);

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Forge: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function loadBridgeConfigDocument(bridgeConfigPath: string): Record<string, unknown> {
  if (!fs.existsSync(bridgeConfigPath)) {
    throw new Error(`Forge: bridge config not found at ${bridgeConfigPath}`);
  }
  const raw = fs.readFileSync(bridgeConfigPath, 'utf8');
  const parsed = yaml.load(raw);
  return asObject(parsed, 'bridge.yaml');
}

function maybeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error(`Forge: bridge.yaml ${field} must be a number`);
  return value;
}

function maybeBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Forge: bridge.yaml ${field} must be a boolean`);
  return value;
}

function maybeString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Forge: bridge.yaml ${field} must be a non-empty string`);
  return value;
}

function maybeStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((e) => typeof e !== 'string')) {
    throw new Error(`Forge: bridge.yaml ${field} must be an array of strings`);
  }
  return value as string[];
}

function maybeReasoningEffort(value: unknown, field: string): ModelConfig['reasoning_effort'] | undefined {
  const effort = maybeString(value, field);
  if (!effort) return undefined;
  if (!REASONING_EFFORTS.has(effort)) {
    throw new Error(`Forge: bridge.yaml ${field} must be one of high, medium, low, none`);
  }
  return effort as ModelConfig['reasoning_effort'];
}

function normalizeProvider(
  entry: BridgeModelEntry,
): 'llama.cpp' | 'ollama' | 'xai' | 'openrouter' | 'openai' | 'openai-compatible' {
  if (
    entry.provider === 'llama.cpp' ||
    entry.provider === 'ollama' ||
    entry.provider === 'xai' ||
    entry.provider === 'openrouter' ||
    entry.provider === 'openai' ||
    entry.provider === 'openai-compatible'
  ) {
    return entry.provider;
  }
  if (typeof entry.gguf_path === 'string' && entry.gguf_path.trim()) return 'llama.cpp';
  return 'ollama';
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/, '');
}

function parseSampling(value: unknown, modelName: string): ModelConfig['sampling'] | undefined {
  if (value === undefined) return undefined;
  const sampling = asObject(value, `bridge.yaml models.${modelName}.sampling`);
  const parsed = {
    temperature: maybeNumber(sampling.temperature, `models.${modelName}.sampling.temperature`),
    top_p: maybeNumber(sampling.top_p, `models.${modelName}.sampling.top_p`),
    top_k: maybeNumber(sampling.top_k, `models.${modelName}.sampling.top_k`),
    min_p: maybeNumber(sampling.min_p, `models.${modelName}.sampling.min_p`),
    max_tokens: maybeNumber(sampling.max_tokens, `models.${modelName}.sampling.max_tokens`),
    seed: maybeNumber(sampling.seed, `models.${modelName}.sampling.seed`),
    presence_penalty: maybeNumber(sampling.presence_penalty, `models.${modelName}.sampling.presence_penalty`),
    frequency_penalty: maybeNumber(sampling.frequency_penalty, `models.${modelName}.sampling.frequency_penalty`),
    repetition_penalty: maybeNumber(sampling.repetition_penalty, `models.${modelName}.sampling.repetition_penalty`),
    repeat_penalty: maybeNumber(sampling.repeat_penalty, `models.${modelName}.sampling.repeat_penalty`),
    repeat_last_n: maybeNumber(sampling.repeat_last_n, `models.${modelName}.sampling.repeat_last_n`),
    stop:
      typeof sampling.stop === 'string'
        ? maybeString(sampling.stop, `models.${modelName}.sampling.stop`)
        : Array.isArray(sampling.stop)
          ? maybeStringArray(sampling.stop, `models.${modelName}.sampling.stop`)
          : sampling.stop === undefined
            ? undefined
            : (() => { throw new Error(`Forge: bridge.yaml models.${modelName}.sampling.stop must be a string or array`); })(),
    preserve_thinking: maybeBoolean(sampling.preserve_thinking, `models.${modelName}.sampling.preserve_thinking`),
  };
  return Object.fromEntries(
    Object.entries(parsed).filter(([, v]) => v !== undefined),
  ) as ModelConfig['sampling'];
}

// ---------------------------------------------------------------------------
// v1 loader — flat llama_server + inline model entries (no config_version)
// ---------------------------------------------------------------------------

export function loadBridgeModels(bridgeConfigPath: string): ModelConfig[] {
  const root = loadBridgeConfigDocument(bridgeConfigPath);

  if (root.config_version === 2) {
    return loadBridgeModelsV2(root);
  }

  const modelsNode = asObject(root.models, 'bridge.yaml models');

  return Object.entries(modelsNode).map(([name, value]) => {
    const entry = asObject(value, `bridge.yaml models.${name}`) as BridgeModelEntry;
    const provider = normalizeProvider(entry);
    const ggufPath = maybeString(entry.gguf_path, `models.${name}.gguf_path`);
    const endpoint = maybeString(entry.endpoint, `models.${name}.endpoint`);
    if (provider === 'llama.cpp' && !ggufPath) {
      throw new Error(`Forge: bridge.yaml models.${name}.gguf_path is required for provider: llama.cpp`);
    }
    if (provider === 'ollama' && !endpoint) {
      throw new Error(`Forge: bridge.yaml models.${name}.endpoint is required for provider: ollama`);
    }
    if (provider === 'openai-compatible' && !endpoint) {
      throw new Error(`Forge: bridge.yaml models.${name}.endpoint is required for provider: openai-compatible`);
    }
    const apiKeySecret = maybeString(entry.api_key_secret, `models.${name}.api_key_secret`);
    if ((provider === 'xai' || provider === 'openrouter' || provider === 'openai' || provider === 'openai-compatible') && !apiKeySecret) {
      throw new Error(`Forge: bridge.yaml models.${name}.api_key_secret is required for provider: ${provider}`);
    }
    const model = {
      name,
      provider,
      gguf_path: ggufPath,
      mmproj_path: maybeString(entry.mmproj_path, `models.${name}.mmproj_path`),
      endpoint: endpoint ? normalizeEndpoint(endpoint) : undefined,
      n_gpu_layers: maybeNumber(entry.n_gpu_layers, `models.${name}.n_gpu_layers`),
      num_ctx: maybeNumber(entry.num_ctx, `models.${name}.num_ctx`),
      n_batch: maybeNumber(entry.n_batch, `models.${name}.n_batch`),
      type_k: entry.type_k as number | string | undefined,
      type_v: entry.type_v as number | string | undefined,
      flash_attn: maybeBoolean(entry.flash_attn, `models.${name}.flash_attn`),
      extra_llama_server_args: maybeStringArray(entry.extra_llama_server_args, `models.${name}.extra_llama_server_args`),
      sampling: parseSampling(entry.sampling, name),
      capabilities: entry.capabilities as ModelConfig['capabilities'],
      strip_tools: maybeBoolean(entry.strip_tools, `models.${name}.strip_tools`),
      system_prompt: maybeString(entry.system_prompt, `models.${name}.system_prompt`),
      think: maybeBoolean(entry.think, `models.${name}.think`),
      reasoning_effort: maybeReasoningEffort(entry.reasoning_effort, `models.${name}.reasoning_effort`),
      strip_thinking_channels: maybeBoolean(entry.strip_thinking_channels, `models.${name}.strip_thinking_channels`),
      api_key_secret: apiKeySecret,
    };
    return Object.fromEntries(
      Object.entries(model).filter(([, fieldValue]) => fieldValue !== undefined),
    ) as unknown as ModelConfig;
  });
}

// ---------------------------------------------------------------------------
// v2 loader — bridge/providers/runtime_defaults/runtimes/sampling_profiles/prompts/models
// Resolution order: model explicit > runtime > runtime_defaults.llama_cpp > undefined
// ---------------------------------------------------------------------------

function loadBridgeModelsV2(root: Record<string, unknown>): ModelConfig[] {
  const samplingProfiles: Record<string, unknown> = root.sampling_profiles
    ? asObject(root.sampling_profiles, 'bridge.yaml sampling_profiles')
    : {};
  const prompts: Record<string, unknown> = root.prompts
    ? asObject(root.prompts, 'bridge.yaml prompts')
    : {};
  const runtimes: Record<string, unknown> = root.runtimes
    ? asObject(root.runtimes, 'bridge.yaml runtimes')
    : {};
  const rtDefaults: RuntimeDefaultsDef = root.runtime_defaults
    ? extractRuntimeDefaults(asObject(root.runtime_defaults, 'bridge.yaml runtime_defaults'))
    : {};

  const modelsNode = asObject(root.models, 'bridge.yaml models');

  return Object.entries(modelsNode).map(([name, value]) => {
    const entry = asObject(value, `bridge.yaml models.${name}`) as BridgeModelEntry;
    const provider = normalizeProvider(entry);

    // Resolve runtime profile
    const rt: RuntimeDef = {};
    if (typeof entry.runtime === 'string') {
      if (!runtimes[entry.runtime]) {
        throw new Error(`Forge: bridge.yaml models.${name}.runtime references unknown runtime "${entry.runtime}"`);
      }
      const rtRaw = asObject(runtimes[entry.runtime], `bridge.yaml runtimes.${entry.runtime}`);
      if (typeof rtRaw.n_parallel === 'number') rt.n_parallel = rtRaw.n_parallel;
      if (typeof rtRaw.num_ctx === 'number') rt.num_ctx = rtRaw.num_ctx;
    }

    // Resolve sampling (string ref → profile object, or inline object)
    let resolvedSampling: ModelConfig['sampling'] | undefined;
    if (typeof entry.sampling === 'string') {
      if (!samplingProfiles[entry.sampling]) {
        throw new Error(`Forge: bridge.yaml models.${name}.sampling references unknown profile "${entry.sampling}"`);
      }
      resolvedSampling = parseSampling(samplingProfiles[entry.sampling], name);
    } else if (entry.sampling !== undefined) {
      resolvedSampling = parseSampling(entry.sampling, name);
    }

    // Resolve system prompt (string ref → prompts section, or inline)
    let systemPrompt: string | undefined;
    if (typeof entry.prompt === 'string') {
      const promptValue = prompts[entry.prompt];
      if (typeof promptValue !== 'string') {
        throw new Error(`Forge: bridge.yaml models.${name}.prompt references unknown prompt "${entry.prompt}"`);
      }
      systemPrompt = promptValue.trim() || undefined;
    } else if (entry.system_prompt !== undefined) {
      systemPrompt = maybeString(entry.system_prompt, `models.${name}.system_prompt`);
    }

    // Runtime field resolution (model explicit > runtime > runtime_defaults)
    const numCtx = getNum(entry.num_ctx) ?? rt.num_ctx;
    const nParallel = getNum(entry.n_parallel) ?? rt.n_parallel;
    const nGpuLayers = getNum(entry.n_gpu_layers) ?? rtDefaults.n_gpu_layers;
    const nBatch = getNum(entry.n_batch) ?? rtDefaults.n_batch;
    const flashAttn = getBool(entry.flash_attn) ?? rtDefaults.flash_attn;
    const typeK = entry.type_k !== undefined ? entry.type_k : rtDefaults.type_k;
    const typeV = entry.type_v !== undefined ? entry.type_v : rtDefaults.type_v;

    // Endpoint / auth validation
    const ggufPath = maybeString(entry.gguf_path, `models.${name}.gguf_path`);
    const endpoint = maybeString(entry.endpoint, `models.${name}.endpoint`);
    if (provider === 'llama.cpp' && !ggufPath) {
      throw new Error(`Forge: bridge.yaml models.${name}.gguf_path is required for provider: llama.cpp`);
    }
    if (provider === 'ollama' && !endpoint) {
      throw new Error(`Forge: bridge.yaml models.${name}.endpoint is required for provider: ollama`);
    }
    if (provider === 'openai-compatible' && !endpoint) {
      throw new Error(`Forge: bridge.yaml models.${name}.endpoint is required for provider: openai-compatible`);
    }
    const apiKeySecret = maybeString(entry.api_key_secret, `models.${name}.api_key_secret`);
    if ((provider === 'xai' || provider === 'openrouter' || provider === 'openai' || provider === 'openai-compatible') && !apiKeySecret) {
      throw new Error(`Forge: bridge.yaml models.${name}.api_key_secret is required for provider: ${provider}`);
    }

    const model = {
      name,
      provider,
      gguf_path: ggufPath,
      mmproj_path: maybeString(entry.mmproj_path, `models.${name}.mmproj_path`),
      endpoint: endpoint ? normalizeEndpoint(endpoint) : undefined,
      n_gpu_layers: nGpuLayers,
      num_ctx: numCtx,
      n_batch: nBatch,
      n_parallel: nParallel,
      type_k: typeK as number | string | undefined,
      type_v: typeV as number | string | undefined,
      flash_attn: flashAttn,
      extra_llama_server_args: maybeStringArray(entry.extra_llama_server_args, `models.${name}.extra_llama_server_args`),
      sampling: resolvedSampling,
      capabilities: entry.capabilities as ModelConfig['capabilities'],
      strip_tools: maybeBoolean(entry.strip_tools, `models.${name}.strip_tools`),
      system_prompt: systemPrompt,
      think: maybeBoolean(entry.think, `models.${name}.think`),
      reasoning_effort: maybeReasoningEffort(entry.reasoning_effort, `models.${name}.reasoning_effort`),
      strip_thinking_channels: maybeBoolean(entry.strip_thinking_channels, `models.${name}.strip_thinking_channels`),
      api_key_secret: apiKeySecret,
    };
    return Object.fromEntries(
      Object.entries(model).filter(([, fieldValue]) => fieldValue !== undefined),
    ) as unknown as ModelConfig;
  });
}

function extractRuntimeDefaults(raw: Record<string, unknown>): RuntimeDefaultsDef {
  const llamaCpp = raw.llama_cpp ? asObject(raw.llama_cpp, 'bridge.yaml runtime_defaults.llama_cpp') : {};
  return {
    n_gpu_layers: getNum(llamaCpp.n_gpu_layers),
    n_batch: getNum(llamaCpp.n_batch),
    type_k: getNum(llamaCpp.type_k),
    type_v: getNum(llamaCpp.type_v),
    flash_attn: getBool(llamaCpp.flash_attn),
  };
}

function getNum(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function getBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function resolveBridgeConfigPath(configPath: string, bridgeConfig: string): string {
  return path.isAbsolute(bridgeConfig)
    ? bridgeConfig
    : path.resolve(path.dirname(configPath), bridgeConfig);
}
