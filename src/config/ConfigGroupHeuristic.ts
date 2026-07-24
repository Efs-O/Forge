import { detectFamily, isLocalModel } from '../backend/ModelHeuristics';
import { deepEqual } from './ConfigWriter';
import type { ForgeConfig, GroupConfig, ModelConfig } from './types';

/**
 * The `Forge: Compact config into groups` grouping heuristic — sole owner of
 * "which fields get lifted into a shared `groups:` entry, and how models
 * are clustered to decide that." Orchestration (verify/backup/write) lives
 * in `ConfigMigrator.ts`, which is the only consumer of this module. See
 * CONFIG_OVERHAUL_PLAN.md §2.6/§4 step 4 and docs/OWNERS.md.
 *
 * Per-key, not all-or-nothing: `ConfigResolver.mergeGroupsIntoModel` merges
 * `spawn`, `sampling`, and `tool_call_limits` KEY-BY-KEY, so a group only
 * needs to carry the keys every partition member actually shares — members
 * keep whichever keys differ (or are absent elsewhere) inline. Scalar fields
 * (provider/endpoint/think/…) still use whole-value present-and-identical
 * comparison, since ConfigResolver overrides those wholesale.
 */

/** Scalar fields — compared and lifted as a single whole value. */
const SCALAR_GROUP_KEYS = [
  'provider',
  'endpoint',
  'num_ctx',
  'think',
  'reasoning_effort',
  'strip_tools',
  'strip_thinking_channels',
  'system_prompt',
  'system_prompt_mode',
  'capabilities',
  'max_output_tokens',
  'tools',
] as const;

/** Nested record fields — merged key-by-key by ConfigResolver, so each key
 *  is a separate lift candidate. Exported for `styleGroupsCompact`. */
export const NESTED_GROUP_FIELDS = ['spawn', 'sampling', 'tool_call_limits'] as const;

/** Coarse clustering key: same provider + same "family" cluster together. */
function partitionKey(model: ModelConfig): string {
  const provider = model.provider ?? 'llama.cpp';
  if (provider === 'llama.cpp') {
    return `llamacpp-${detectFamily(model.gguf_path ?? model.name)}`;
  }
  if (provider === 'ollama') {
    return isLocalModel(model) ? 'ollama-local' : 'ollama-cloud';
  }
  return `${provider}-cloud`;
}

function uniqueGroupName(base: string, used: Set<string>): string {
  const sanitized = base.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (!used.has(sanitized)) return sanitized;
  let n = 2;
  while (used.has(`${sanitized}-${n}`)) n++;
  return `${sanitized}-${n}`;
}

/** `"spawn.n_batch"` -> `{ prefix: "spawn", rest: "n_batch" }`;
 *  `"scalar.think"` -> `{ prefix: "scalar", rest: "think" }`. */
export function splitFlatKey(flatKey: string): { prefix: string; rest: string } {
  const dotIndex = flatKey.indexOf('.');
  return { prefix: flatKey.slice(0, dotIndex), rest: flatKey.slice(dotIndex + 1) };
}

/** Flatten a model's group-eligible fields into `"scalar.<key>"` /
 *  `"<nested>.<key>"` entries, omitting anything undefined. Absence is
 *  never a candidate value — a key only appears here when the model
 *  actually defines it. */
function flattenCandidateFields(model: ModelConfig): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const asRecord = model as unknown as Record<string, unknown>;
  for (const key of SCALAR_GROUP_KEYS) {
    const value = asRecord[key];
    if (value !== undefined) flat[`scalar.${key}`] = value;
  }
  for (const field of NESTED_GROUP_FIELDS) {
    const obj = asRecord[field] as Record<string, unknown> | undefined;
    if (!obj) continue;
    for (const [subKey, value] of Object.entries(obj)) {
      if (value !== undefined) flat[`${field}.${subKey}`] = value;
    }
  }
  return flat;
}

/** Flat keys present (defined) on every one of `flats`. */
function candidateKeysAcross(flats: Record<string, unknown>[]): string[] {
  const [first, ...rest] = flats;
  if (!first) return [];
  return Object.keys(first).filter((key) => rest.every((flat) => key in flat));
}

interface SharedFieldsResult {
  /** flat key -> value, for keys defined and identical across every member */
  shared: Record<string, unknown>;
  /** flat keys defined on every member but NOT identical across all of them */
  contested: string[];
}

/** For a member set, split their common candidate keys into `shared`
 *  (identical everywhere — liftable) and `contested` (present everywhere but
 *  disagreeing — the basis for sub-clustering). */
function computeSharedFields(members: ModelConfig[]): SharedFieldsResult {
  const flats = members.map(flattenCandidateFields);
  const shared: Record<string, unknown> = {};
  const contested: string[] = [];
  for (const key of candidateKeysAcross(flats)) {
    const [first, ...rest] = flats.map((flat) => flat[key]);
    if (rest.every((value) => deepEqual(value, first))) shared[key] = first;
    else contested.push(key);
  }
  return { shared, contested };
}

/**
 * Split a partition into sub-clusters so a single outlier (e.g. one model
 * with a different stop token) doesn't block every other member from
 * factoring. Members are grouped by their combined value across every
 * contested key; members that agree on all of them join the same
 * sub-cluster. Deterministic: bucket order follows first-seen member order,
 * and a partition with no contested keys returns a single sub-cluster.
 */
function subCluster(members: ModelConfig[]): ModelConfig[][] {
  const { contested } = computeSharedFields(members);
  if (contested.length === 0) return [members];

  const flats = members.map(flattenCandidateFields);
  const buckets = new Map<string, ModelConfig[]>();
  members.forEach((model, index) => {
    const signature = JSON.stringify(contested.map((key) => [key, flats[index][key]]));
    const bucket = buckets.get(signature) ?? [];
    bucket.push(model);
    buckets.set(signature, bucket);
  });
  return [...buckets.values()];
}

/** Rebuild a `GroupConfig`-shaped object from flat `shared` entries. */
function unflattenToGroupConfig(shared: Record<string, unknown>): GroupConfig {
  const group: Record<string, unknown> = {};
  for (const [flatKey, value] of Object.entries(shared)) {
    const { prefix, rest } = splitFlatKey(flatKey);
    if (prefix === 'scalar') {
      group[rest] = value;
    } else {
      const sub = (group[prefix] as Record<string, unknown> | undefined) ?? {};
      sub[rest] = value;
      group[prefix] = sub;
    }
  }
  return group as GroupConfig;
}

/** Only worth creating a group when it captures at least one of the actual
 *  bloat sources — a group of purely cosmetic scalar overlap is dead weight. */
function hasBloatField(shared: Record<string, unknown>): boolean {
  return Object.keys(shared).some(
    (key) => key.startsWith('spawn.') || key.startsWith('sampling.') || key === 'scalar.endpoint',
  );
}

export interface ComputedGroups {
  groups: Record<string, GroupConfig>;
  /** model name -> assigned group name */
  assignment: Record<string, string>;
  /** model name -> flat field keys removed from that model (now supplied by
   *  its group), e.g. `"scalar.think"`, `"spawn.n_batch"` */
  removedFields: Record<string, string[]>;
}

/**
 * Deterministic heuristic: partition models by provider+family, sub-cluster
 * each partition so an outlier on a contested field doesn't block the rest,
 * then for each sub-cluster of 2+ members lift every flat key (scalar whole
 * value, or individual spawn/sampling/tool_call_limits key) that every
 * member defines identically. Per-model overrides — any key that differs or
 * is absent on any member — always stay inline.
 */
export function computeGroups(config: ForgeConfig): ComputedGroups {
  const partitions = new Map<string, ModelConfig[]>();
  for (const model of config.models) {
    const key = partitionKey(model);
    const list = partitions.get(key) ?? [];
    list.push(model);
    partitions.set(key, list);
  }

  const groups: Record<string, GroupConfig> = { ...(config.groups ?? {}) };
  const assignment: Record<string, string> = {};
  const removedFields: Record<string, string[]> = {};
  const usedNames = new Set(Object.keys(groups));

  for (const [key, members] of partitions) {
    if (members.length < 2) continue;

    // Per-key lifting already tolerates a member disagreeing on any single
    // field — that field just stays out of `shared` and inline on every
    // member, no fragmentation needed. Only fall back to sub-clustering when
    // the whole partition, taken together, doesn't share anything worth a
    // group at all (i.e. an outlier's disagreement is pervasive enough to
    // blank out `shared` entirely) — then a majority subset may still.
    const wholePartition = computeSharedFields(members);
    const clusters = hasBloatField(wholePartition.shared) ? [members] : subCluster(members);
    const validClusters = clusters.filter((cluster) => cluster.length >= 2);
    validClusters.forEach((clusterMembers, index) => {
      const { shared } = computeSharedFields(clusterMembers);
      if (!hasBloatField(shared)) return;

      const suffix = validClusters.length > 1 ? `-${index + 1}` : '';
      const groupName = uniqueGroupName(`${key}${suffix}`, usedNames);
      usedNames.add(groupName);
      groups[groupName] = unflattenToGroupConfig(shared);
      for (const model of clusterMembers) {
        assignment[model.name] = groupName;
        removedFields[model.name] = Object.keys(shared);
      }
    });
  }

  return { groups, assignment, removedFields };
}

/** Remove the given flat keys from `model` (deleting an emptied nested
 *  parent), returning a new object — pure, no document I/O. */
function stripFlatFields(model: ModelConfig, flatKeys: string[]): ModelConfig {
  const next: Record<string, unknown> = { ...model };
  for (const flatKey of flatKeys) {
    const { prefix, rest } = splitFlatKey(flatKey);
    if (prefix === 'scalar') {
      delete next[rest];
      continue;
    }
    const sub = next[prefix] as Record<string, unknown> | undefined;
    if (!sub) continue;
    const nextSub = { ...sub };
    delete nextSub[rest];
    if (Object.keys(nextSub).length === 0) delete next[prefix];
    else next[prefix] = nextSub;
  }
  return next as unknown as ModelConfig;
}

/** Build the fully-resolved in-memory config the migration would produce, for
 *  the verifier to diff against the original — no file/document I/O here. */
export function applyComputedGroups(config: ForgeConfig, computed: ComputedGroups): ForgeConfig {
  const models = config.models.map((model) => {
    const groupName = computed.assignment[model.name];
    if (!groupName) return model;
    const stripped = stripFlatFields(model, computed.removedFields[model.name] ?? []);
    return { ...stripped, group: groupName } as ModelConfig;
  });
  return { ...config, groups: computed.groups, models };
}
