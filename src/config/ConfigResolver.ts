import type {
  ForgeConfig,
  GroupConfig,
  ModelConfig,
  ProfileConfig,
  SamplingConfig,
  SpawnConfig,
} from './types';

/** Fields that configuration layers may overlay on a concrete named model. */
type ModelOverlayKey = Exclude<keyof ModelConfig, 'name'>;
type ModelOverlay = { [K in ModelOverlayKey]?: ModelConfig[K] | undefined };

/**
 * F6 — model/profile resolution. Two flavors, both flattening to legacy
 * `ModelConfig` so every downstream consumer stays unchanged:
 *   - request-time: defaults < base request fields < named profile
 *   - spawn-time:   base flat/spawn < spawn_profile
 * See `docs/plans/F6_PROFILES_PLAN.md`.
 *
 * F7 — `groups` ("boards") and fuzzy model-name resolution layer on top:
 * precedence is `defaults < group(s) < model fields < profile`. Groups are
 * merged into the base model once, in `findBase`, so both request-time and
 * spawn-time flattening automatically see group-derived fields as if they
 * were declared directly on the model. See docs/plans/CONFIG_OVERHAUL_PLAN.md §2.1/§2.2.
 */

/** Thrown when a fuzzy model lookup matches more than one configured model.
 *  Callers must never guess between candidates — surface this to the user. */
export class AmbiguousModelError extends Error {
  readonly query: string;
  readonly candidates: string[];

  constructor(query: string, candidates: string[]) {
    super(`Ambiguous model "${query}": matches ${candidates.join(', ')}`);
    this.name = 'AmbiguousModelError';
    this.query = query;
    this.candidates = candidates;
  }
}

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

/**
 * Deterministic fuzzy model-name resolver, single owner for every lookup
 * that accepts a user- or model-supplied identifier (chat picker, delegation,
 * workers, control server). Matching order, first non-empty stage wins:
 *   1. exact name
 *   2. exact alias key
 *   3. exact short_name
 *   4. case-insensitive exact (name / alias / short_name)
 *   5. unique prefix match (name / short_name)
 *   6. unique substring match (name / short_name)
 * A stage yielding more than one candidate throws `AmbiguousModelError`
 * listing every candidate — never guesses between matches. `query` must
 * already have any `@profile` suffix stripped by the caller.
 */
export function resolveModelName(config: ForgeConfig, query: string): string {
  const models = config.models;

  const exactName = models.find((m) => m.name === query);
  if (exactName) return exactName.name;

  const aliasTarget = config.aliases?.[query];
  if (aliasTarget) return splitModelProfile(aliasTarget).base;

  const exactShort = models.find((m) => m.short_name === query);
  if (exactShort) return exactShort.name;

  const lowerQuery = query.toLowerCase();

  const ciCandidates = new Set<string>();
  for (const m of models) {
    if (m.name.toLowerCase() === lowerQuery) ciCandidates.add(m.name);
    if (m.short_name?.toLowerCase() === lowerQuery) ciCandidates.add(m.name);
  }
  for (const [key, target] of Object.entries(config.aliases ?? {})) {
    if (key.toLowerCase() === lowerQuery) ciCandidates.add(splitModelProfile(target).base);
  }
  if (ciCandidates.size === 1) return [...ciCandidates][0];
  if (ciCandidates.size > 1) throw new AmbiguousModelError(query, [...ciCandidates].sort());

  const prefixCandidates = new Set<string>();
  for (const m of models) {
    if (m.name.toLowerCase().startsWith(lowerQuery)) prefixCandidates.add(m.name);
    else if (m.short_name?.toLowerCase().startsWith(lowerQuery)) prefixCandidates.add(m.name);
  }
  if (prefixCandidates.size === 1) return [...prefixCandidates][0];
  if (prefixCandidates.size > 1) throw new AmbiguousModelError(query, [...prefixCandidates].sort());

  const substringCandidates = new Set<string>();
  for (const m of models) {
    if (m.name.toLowerCase().includes(lowerQuery)) substringCandidates.add(m.name);
    else if (m.short_name?.toLowerCase().includes(lowerQuery)) substringCandidates.add(m.name);
  }
  if (substringCandidates.size === 1) return [...substringCandidates][0];
  if (substringCandidates.size > 1) {
    throw new AmbiguousModelError(query, [...substringCandidates].sort());
  }

  throw new Error(
    `Forge: unknown model "${query}" (configured: ${models.map((m) => m.name).join(', ') || 'none'})`,
  );
}

function findBase(config: ForgeConfig, base: string): ModelConfig {
  const exact = config.models.find((m) => m.name === base);
  const model = exact ?? config.models.find((m) => m.name === resolveModelName(config, base));
  if (!model) {
    throw new Error(
      `Forge: unknown model "${base}" (configured: ${config.models.map((m) => m.name).join(', ') || 'none'})`,
    );
  }
  return mergeGroupsIntoModel(config, model);
}

/** Shallow key-by-key merge across ordered layers (higher index wins per key). */
function mergeRecord<T extends object>(...layers: (T | undefined)[]): T | undefined {
  let merged: T | undefined;
  for (const layer of layers) {
    if (!layer) continue;
    merged = { ...(merged ?? ({} as T)), ...layer };
  }
  return merged;
}

function mergeSampling(...layers: (SamplingConfig | undefined)[]): SamplingConfig | undefined {
  return mergeRecord<SamplingConfig>(...layers);
}

/**
 * Fold a model's `group`/`groups` into itself: group(s) apply beneath the
 * model's own explicit fields (defaults < group(s) < model fields). Groups
 * are merged left-to-right when `groups` lists more than one (later wins).
 * `sampling`, `spawn`, and `tool_call_limits` are merged key-by-key across
 * every layer; every other field is a plain override (higher layer wins
 * wholesale, matching the existing `pick()` semantics used elsewhere).
 */
export function mergeGroupsIntoModel(config: ForgeConfig, model: ModelConfig): ModelConfig {
  const groupNames = model.groups ?? (model.group ? [model.group] : []);
  if (groupNames.length === 0) return model;

  const groups = groupNames
    .map((name) => config.groups?.[name])
    .filter((g): g is GroupConfig => Boolean(g));
  if (groups.length === 0) return model;

  let groupFields: ModelOverlay = {};
  const samplingLayers: (SamplingConfig | undefined)[] = [];
  const spawnLayers: (SpawnConfig | undefined)[] = [];
  const limitLayers: (Record<string, number> | undefined)[] = [];
  for (const g of groups) {
    const { sampling, spawn, tool_call_limits, ...rest } = g;
    groupFields = { ...groupFields, ...rest };
    samplingLayers.push(sampling);
    spawnLayers.push(spawn);
    limitLayers.push(tool_call_limits);
  }
  samplingLayers.push(model.sampling);
  spawnLayers.push(model.spawn);
  limitLayers.push(model.tool_call_limits);

  const modelFields: Partial<ModelConfig> = { ...model };
  delete modelFields.name;
  const merged = withDefined(withDefined({ name: model.name }, groupFields), modelFields);
  const mergedSampling = mergeSampling(...samplingLayers);
  const mergedSpawn = mergeRecord<SpawnConfig>(...spawnLayers);
  const mergedLimits = mergeRecord<Record<string, number>>(...limitLayers);
  if (mergedSampling) merged.sampling = mergedSampling;
  else delete merged.sampling;
  if (mergedSpawn) merged.spawn = mergedSpawn;
  else delete merged.spawn;
  if (mergedLimits) merged.tool_call_limits = mergedLimits;
  else delete merged.tool_call_limits;
  return merged;
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
function withDefined(base: ModelConfig, overrides: ModelOverlay): ModelConfig {
  const out: ModelConfig = { ...base };
  for (const key of Object.keys(overrides) as ModelOverlayKey[]) {
    applyDefinedModelField(out, key, overrides[key]);
  }
  return out;
}

function applyDefinedModelField<K extends ModelOverlayKey>(
  target: ModelConfig,
  key: K,
  value: ModelOverlay[K],
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Request-time flatten: `defaults` < base request fields < named `profile`.
 * Spawn-time facts pass through from the base untouched. Throws on unknown
 * base or unknown profile.
 */
export function resolveRequestModel(
  config: ForgeConfig,
  id: string,
  log?: (msg: string) => void,
): ModelConfig {
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
    system_prompt_mode: pick(d.system_prompt_mode, model.system_prompt_mode, p.system_prompt_mode),
    sampling: mergeSampling(d.sampling, model.sampling, p.sampling),
    think: pick(d.think, model.think, p.think),
    reasoning_effort: pick(d.reasoning_effort, model.reasoning_effort, p.reasoning_effort),
    strip_tools: pick(d.strip_tools, model.strip_tools, p.strip_tools),
    strip_thinking_channels: pick(
      d.strip_thinking_channels,
      model.strip_thinking_channels,
      p.strip_thinking_channels,
    ),
    capabilities: pick(d.capabilities, model.capabilities, p.capabilities),
    max_tool_rounds: pick(d.max_tool_rounds, model.max_tool_rounds, p.max_tool_rounds),
  });
}

/**
 * Spawn-time flatten: legacy flat fields < `spawn` block < `spawn_profiles[sp]`.
 * Output is a flat `ModelConfig` (num_ctx/n_parallel/type_k/…), so
 * `LlamaServerArgs` is unchanged. Throws on unknown base / unknown spawn profile.
 */
export function resolveSpawnModel(
  config: ForgeConfig,
  base: string,
  spawnProfile?: string,
): ModelConfig {
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
    extra_llama_server_args: pick(
      model.extra_llama_server_args,
      spawn.extra_llama_server_args,
      sp.extra_llama_server_args,
    ),
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
