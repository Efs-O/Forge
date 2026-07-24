import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import {
  applyComputedGroups,
  computeGroups,
  NESTED_GROUP_FIELDS,
  splitFlatKey,
} from './ConfigGroupHeuristic';
import { loadConfig } from './ConfigLoader';
import {
  resolveRequestModel,
  resolveSpawnModel,
  splitModelProfile,
  listProfiles,
} from './ConfigResolver';
import {
  deepEqual,
  deleteModelSubField,
  setModelField,
  setTopLevel,
  updateConfigFile,
} from './ConfigWriter';
import type { ForgeConfig } from './types';

/**
 * One-shot migration: factor repeated spawn/sampling/endpoint/think blocks
 * across models into `groups:` ("boards") via `ConfigGroupHeuristic`, verify
 * a zero resolved-config diff, then write through the comment-preserving
 * writer. See CONFIG_OVERHAUL_PLAN.md §2.6 and §4 step 4. Owner for the
 * resolved-diff verifier and the end-to-end migration flow; the grouping
 * heuristic itself lives in `ConfigGroupHeuristic.ts`. Command registration
 * lives in `src/vscode/nativeCommands.ts` (`forge.compactConfig`). See
 * docs/OWNERS.md.
 */

/** Every identifier the verifier must check resolution for: every model
 *  name, short_name, alias key — and each of those combined with every
 *  defined request profile as `id@profile`. */
function collectResolveIds(config: ForgeConfig): string[] {
  const bases = new Set<string>();
  for (const model of config.models) {
    bases.add(model.name);
    if (model.short_name) bases.add(model.short_name);
  }
  for (const alias of Object.keys(config.aliases ?? {})) bases.add(alias);

  const profiles = listProfiles(config);
  const ids = new Set(bases);
  for (const base of bases) {
    for (const profile of profiles) ids.add(`${base}@${profile}`);
  }
  return [...ids];
}

export interface VerifyResult {
  ok: boolean;
  diffs: string[];
}

/**
 * The hard requirement: for every model name/alias/short_name and
 * name@profile combination, `resolveRequestModel` and `resolveSpawnModel`
 * must return deep-identical results against `oldConfig` and `newConfig`.
 * Any mismatch (or any resolution newly throwing) is reported; capped at
 * `maxDiffs` entries.
 */
export function verifyResolvedDiff(
  oldConfig: ForgeConfig,
  newConfig: ForgeConfig,
  maxDiffs = 10,
): VerifyResult {
  const diffs: string[] = [];
  for (const id of collectResolveIds(oldConfig)) {
    if (diffs.length >= maxDiffs) break;
    try {
      const before = withoutGroupRefs(resolveRequestModel(oldConfig, id));
      const after = withoutGroupRefs(resolveRequestModel(newConfig, id));
      if (!deepEqual(before, after)) {
        diffs.push(`resolveRequestModel("${id}") changed: ${describeDiff(before, after)}`);
      }
    } catch (err) {
      diffs.push(`resolveRequestModel("${id}") now throws: ${(err as Error).message}`);
    }

    const base = splitModelProfile(id).base;
    try {
      const before = withoutGroupRefs(resolveSpawnModel(oldConfig, base));
      const after = withoutGroupRefs(resolveSpawnModel(newConfig, base));
      if (!deepEqual(before, after)) {
        diffs.push(`resolveSpawnModel("${base}") changed: ${describeDiff(before, after)}`);
      }
    } catch (err) {
      diffs.push(`resolveSpawnModel("${base}") now throws: ${(err as Error).message}`);
    }
  }
  return { ok: diffs.length === 0, diffs };
}

/** `group`/`groups` are provenance metadata the migration intentionally
 *  attaches to a model — they carry no request/spawn behavior of their own
 *  (their *effect* is what every other field in the resolved output already
 *  captures), so the verifier ignores their literal presence and compares
 *  everything else byte-for-byte. */
function withoutGroupRefs<T extends { group?: unknown; groups?: unknown }>(
  model: T,
): Omit<T, 'group' | 'groups'> {
  const rest: Record<string, unknown> = { ...model };
  delete rest['group'];
  delete rest['groups'];
  return rest as Omit<T, 'group' | 'groups'>;
}

function describeDiff(before: unknown, after: unknown): string {
  const beforeKeys = before as Record<string, unknown>;
  const afterKeys = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(beforeKeys ?? {}), ...Object.keys(afterKeys ?? {})]);
  const changed = [...keys].filter((k) => !deepEqual(beforeKeys?.[k], afterKeys?.[k]));
  return changed.join(', ') || '(unknown)';
}

/** Render each newly-added group's `spawn`/`sampling`/`tool_call_limits`
 *  sub-blocks in flow style (`{ … }`) to match the compact convention model
 *  entries already use for those fields — a freshly created Document node
 *  otherwise defaults to multi-line block style, which would inflate the
 *  very line count this migration exists to shrink. */
function styleGroupsCompact(doc: YAML.Document): void {
  const groupsNode = doc.get('groups', true);
  if (!groupsNode || !YAML.isMap(groupsNode)) return;
  for (const groupItem of groupsNode.items) {
    const groupMap = groupItem.value;
    if (!YAML.isMap(groupMap)) continue;
    for (const field of NESTED_GROUP_FIELDS) {
      const sub = groupMap.get(field, true);
      if (sub && (YAML.isMap(sub) || YAML.isSeq(sub))) sub.flow = true;
    }
  }
}

export interface MigrationResult {
  migrated: boolean;
  reason?: string;
  diffs?: string[];
  linesBefore?: number;
  linesAfter?: number;
  backupPath?: string;
  groupCount?: number;
}

/**
 * Run the migration end-to-end against the config file at `configPath`:
 * compute groups, verify a zero resolved-config diff, back up the original,
 * then rewrite via the comment-preserving writer. Writes nothing if the
 * verifier finds any mismatch or if no shared config is found to factor out.
 */
export function migrateConfig(configPath: string): MigrationResult {
  const directory = path.dirname(configPath);
  const oldConfig = loadConfig(directory);
  const rawBefore = fs.readFileSync(configPath, 'utf8');
  const linesBefore = rawBefore.split('\n').length;

  const computed = computeGroups(oldConfig);
  if (Object.keys(computed.assignment).length === 0) {
    return {
      migrated: false,
      reason: 'no repeated spawn/sampling/endpoint blocks to factor into groups',
    };
  }

  const newConfig = applyComputedGroups(oldConfig, computed);
  const verify = verifyResolvedDiff(oldConfig, newConfig);
  if (!verify.ok) {
    return {
      migrated: false,
      reason: 'resolved-config verifier found mismatches',
      diffs: verify.diffs,
    };
  }

  const backupPath = `${configPath}.bak-v2migration`;
  fs.copyFileSync(configPath, backupPath);

  updateConfigFile(configPath, (doc) => {
    setTopLevel(doc, 'groups', computed.groups);
    styleGroupsCompact(doc);
    for (const [modelName, groupName] of Object.entries(computed.assignment)) {
      for (const flatKey of computed.removedFields[modelName] ?? []) {
        const { prefix, rest } = splitFlatKey(flatKey);
        if (prefix === 'scalar') setModelField(doc, modelName, rest, undefined);
        else deleteModelSubField(doc, modelName, prefix, rest);
      }
      setModelField(doc, modelName, 'group', groupName);
    }
  });

  const rawAfter = fs.readFileSync(configPath, 'utf8');
  const linesAfter = rawAfter.split('\n').length;

  return {
    migrated: true,
    linesBefore,
    linesAfter,
    backupPath,
    groupCount: Object.keys(computed.groups).length,
  };
}
