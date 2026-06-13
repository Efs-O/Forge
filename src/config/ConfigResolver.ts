import type { ForgeConfig, ModelConfig, ProfileConfig, SamplingConfig, SpawnConfig } from './types';

/**
 * F6 — model/profile resolution. Two flavors, both flattening to legacy
 * `ModelConfig` so every downstream consumer stays unchanged:
 *   - request-time: defaults < base request fields < named profile
 *   - spawn-time:   base flat/spawn < spawn_profile
 * See `F6_PROFILES_PLAN.md`.
 */

/** num_ctx at/above which a model is tagged `long-context` when deriving caps. */
const LONG_CONTEXT_CTX = 131072;

const PROFILE_SUFFIX = /^(.*)@([A-Za-z0-9_-]+)$/;

/** Split a `base@profile` id. Only a trailing `@<profile>` is stripped; any
 *  internal `@`/`:` (e.g. `forge:model`) is left intact. */
export function splitModelProfile(id: string): { base: string; profile?: string } {
  const m = PROFILE_SUFFIX.exec(id);
  if (!m || m[1].length === 0) return { base: id };
  return { base: m[1], profile: m[2] };
}

/** If `id`'s base matches an alias key, return the alias target. An explicit
 *  `@profile` on the input overrides the profile baked into the alias target. */
export function expandAlias(config: ForgeConfig, id: string, log?: (msg: string) => void): string {
  const aliases = config.aliases ?? {};
  const { base, profile } = splitModelProfile(id);
  const target = aliases[base];
  if (!target) return id;
  log?.(`F6: alias "${base}" → "${target}" (migrate config to the new model@profile form)`);
  if (profile) {
    const targetBase = splitModelProfile(target).base;
    return `${targetBase}@${profile}`;
  }
  return target;
}

function findBase(config: ForgeConfig, base: string): ModelConfig {
  const model = config.models.find((m) => m.name === base);
  if (!model) {
    throw new Error(
      `Forge: unknown model "${base}" (configured: ${config.models.map((m) => m.name).join(', ') || 'none'})`,
    );
  }
  return model;
}

function mergeSampling(...layers: (SamplingConfig | undefined)[]): SamplingConfig | undefined {
  const merged: SamplingConfig = {};
  let any = false;
  for (const layer of layers) {
    if (!layer) continue;
    any = true;
    Object.assign(merged, layer);
  }
  return any ? merged : undefined;
}

/** Highest-precedence defined value across layers ordered low→high. */
function pick<T>(...layers: (T | undefined)[]): T | undefined {
  let value: T | undefined;
  for (const layer of layers) {
    if (layer !== undefined) value = layer;
  }
  return value;
}

/** Clone `base`, overlaying only the defined entries of `overrides`. Avoids
 *  assigning `undefined` to optional fields (exactOptionalPropertyTypes). */
function withDefined(base: ModelConfig, overrides: Record<string, unknown>): ModelConfig {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) out[k] = v;
  }
  return out as unknown as ModelConfig;
}

/**
 * Request-time flatten: `defaults` < base request fields < named `profile`.
 * Spawn-time facts pass through from the base untouched. Throws on unknown
 * base or unknown profile.
 */
export function resolveRequestModel(config: ForgeConfig, id: string, log?: (msg: string) => void): ModelConfig {
  const expanded = expandAlias(config, id, log);
  const { base, profile } = splitModelProfile(expanded);
  const model = findBase(config, base);

  const d: ProfileConfig = config.defaults ?? {};
  let p: ProfileConfig = {};
  if (profile !== undefined) {
    const found = config.profiles?.[profile];
    if (!found) {
      throw new Error(
        `Forge: unknown profile "${profile}" for model "${base}" (available: ${Object.keys(config.profiles ?? {}).join(', ') || 'none'})`,
      );
    }
    p = found;
  }

  return withDefined(model, {
    system_prompt: pick(d.system_prompt, model.system_prompt, p.system_prompt),
    sampling: mergeSampling(d.sampling, model.sampling, p.sampling),
    think: pick(d.think, model.think, p.think),
    reasoning_effort: pick(d.reasoning_effort, model.reasoning_effort, p.reasoning_effort),
    strip_tools: pick(d.strip_tools, model.strip_tools, p.strip_tools),
    strip_thinking_channels: pick(d.strip_thinking_channels, model.strip_thinking_channels, p.strip_thinking_channels),
    capabilities: pick(d.capabilities, model.capabilities, p.capabilities),
  });
}

/**
 * Spawn-time flatten: legacy flat fields < `spawn` block < `spawn_profiles[sp]`.
 * Output is a flat `ModelConfig` (num_ctx/n_parallel/type_k/…), so
 * `LlamaServerArgs` is unchanged. Throws on unknown base / unknown spawn profile.
 */
export function resolveSpawnModel(config: ForgeConfig, base: string, spawnProfile?: string): ModelConfig {
  const model = findBase(config, base);
  const spawn: SpawnConfig = model.spawn ?? {};
  let sp: SpawnConfig = {};
  if (spawnProfile !== undefined) {
    const found = model.spawn_profiles?.[spawnProfile];
    if (!found) {
      throw new Error(
        `Forge: unknown spawn profile "${spawnProfile}" for model "${base}" (available: ${Object.keys(model.spawn_profiles ?? {}).join(', ') || 'none'})`,
      );
    }
    sp = found;
  }

  return withDefined(model, {
    num_ctx: pick(model.num_ctx, spawn.num_ctx, sp.num_ctx),
    n_parallel: pick(model.n_parallel, spawn.n_parallel, sp.n_parallel),
    n_batch: pick(model.n_batch, spawn.n_batch, sp.n_batch),
    type_k: pick(model.type_k, spawn.type_k, sp.type_k),
    type_v: pick(model.type_v, spawn.type_v, sp.type_v),
    flash_attn: pick(model.flash_attn, spawn.flash_attn, sp.flash_attn),
    n_gpu_layers: pick(model.n_gpu_layers, spawn.n_gpu_layers, sp.n_gpu_layers),
    extra_llama_server_args: pick(model.extra_llama_server_args, spawn.extra_llama_server_args, sp.extra_llama_server_args),
  });
}

type Capability = 'tool-call' | 'vision' | 'long-context';

/**
 * Static capability derivation for catalog display: explicit `capabilities`
 * win and are unioned with derived facts — `vision` from `mmproj_path`,
 * `long-context` from a `long-context` spawn profile or a large num_ctx.
 * `tool-call` is detected at runtime (ModelCapabilities), so it is only
 * surfaced here when declared explicitly.
 */
export function deriveStaticCapabilities(model: ModelConfig): Capability[] {
  const caps = new Set<Capability>(model.capabilities ?? []);
  if (model.mmproj_path) caps.add('vision');
  const ctx = model.spawn?.num_ctx ?? model.num_ctx;
  const hasLongCtxProfile = model.spawn_profiles ? 'long-context' in model.spawn_profiles : false;
  if (hasLongCtxProfile || (ctx !== undefined && ctx >= LONG_CONTEXT_CTX)) caps.add('long-context');
  return [...caps];
}

/** All defined request-time profile names. */
export function listProfiles(config: ForgeConfig): string[] {
  return Object.keys(config.profiles ?? {});
}

/** Profiles applicable to a base model. Profiles are generic presets, so every
 *  defined profile applies; the base must exist. */
export function availableProfilesFor(config: ForgeConfig, base: string): string[] {
  findBase(config, base);
  return listProfiles(config);
}
