import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { withForgeConfigLock } from './ConfigWriter';
import { deepEqual } from './ConfigWriterHelpers';
import { checkConfigCrossRefs } from './configChecks';
import { ForgeConfigSchema } from './schema';
import { ENGINE_EXEC_FIELDS, engineNameForModel } from './engineSchema';
import { POLICY_KEYS } from './policySchema';
import { defaultPolicyPath, policyFileHasContent, readYamlMapFile } from './PolicyLoader';
import { policyFileIsLocked, policyLockedMessage } from './policyLock';
import {
  findForeignAlias,
  findPair,
  nonLoopbackHostsOf,
  parseDocument,
  plainValueOf,
  readFileOrThrow,
  requireTopMap,
  scalarText,
  stringListOf,
} from './policyYamlNodes';
import type { ForgeConfig } from './types';

/**
 * `Forge: Move security settings to policy.yaml`, as a pure function so it can be
 * tested on a fixture copy of the owner's config and never on the live one.
 *
 * It moves every policy key out of `config.yaml` into `~/.forge/policy.yaml` and
 * turns each model's exec fields (`start_command`, `stop_command`, `unload_path`,
 * `llama_server_binary`) into a named engine, leaving `engine: <name>` where the
 * fields were. Doing this with the `yaml` Document API rather than rewriting from
 * an object is the whole design: the comments say WHY a port is pinned, why a
 * model runs `-ngl -1`, which GPU a patched fork is for. A rewrite from `toJS()`
 * would drop every one of them and still report success, and the owner would
 * discover the loss a year later, when the annotation is gone and the reason with
 * it. So each block is moved as the node it already is, comments attached.
 *
 * Nothing here runs automatically: the owner runs the command, sees what moved,
 * and can undo it by hand from the backup. Policy.yaml is written first, so a
 * crash between the two writes leaves a key in both files — which `PolicyLoader`
 * refuses by name, and which a second run of this function finishes, because the
 * policy side already holds what the migration would write and is left alone.
 *
 * vscode-free: the command handler is thin, and every interesting case (comments
 * survive, engines deduplicate, a re-run finishes, a foreign anchor is refused)
 * is tested in plain node against fixture copies.
 */

const BACKUP_PREFIX = 'config.yaml.pre-policy-';

export interface PolicyMigrationOptions {
  /** `~/.forge/policy.yaml` by default. Tests pass a fixture copy: this command
   *  must never touch the live policy file from a test. */
  policyPath?: string;
  /** For the backup name; injectable so a test can pin the stamp. */
  now?: Date;
}

export interface EnginePlanRow {
  name: string;
  /** The exec fields this engine carries, in written order. */
  fields: string[];
  models: string[];
  /** Set when the group name was already taken by a different field set, so the
   *  owner can read why the engine is `llamacpp-x-2` and not `llamacpp-x`. */
  renamedFrom?: string;
}

export interface PolicyMigrationResult {
  configPath: string;
  policyPath: string;
  backupPath: string;
  /** Policy keys that moved out of config.yaml. */
  movedKeys: string[];
  /** Policy keys already in policy.yaml with the same value: a re-run after a
   *  crash removes them from config.yaml and leaves policy.yaml byte-for-byte. */
  alreadyInPolicy: string[];
  engines: EnginePlanRow[];
  /** Non-loopback hosts the migrated models name, written into `model_hosts` so
   *  phase 3's non-loopback rule does not refuse a server the owner has been
   *  talking to all along. */
  model_hosts: string[];
  /** False when policy.yaml already held exactly what the migration writes. */
  policyWritten: boolean;
}

export function runPolicyMigration(
  configPath: string,
  options: PolicyMigrationOptions = {},
): PolicyMigrationResult {
  const policyPath = options.policyPath ?? defaultPolicyPath();
  // A locked policy file is refused before anything is read, backed up or written.
  // The migration replaces policy.yaml wholesale, and on Windows a rename succeeds
  // past a read-only entry when the folder grants "delete child" — measured here —
  // so running it against a file the owner had just protected would report success
  // for a change the owner meant to be impossible until they unlocked it.
  if (policyFileIsLocked(policyPath)) throw new Error(policyLockedMessage(policyPath));
  // Both locks, config first, for the whole run: another window's wizard, job or
  // llama.cpp install can be writing either file, and a migration that read
  // config.yaml, let go, and wrote later would overwrite whatever landed in
  // between — losing a binary switch, or re-adding a key the migration had just
  // moved out. The policy dir is made first because the lock file lives beside
  // the policy file, and `~/.forge` may not exist on a machine that has never
  // had a policy file.
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  return withForgeConfigLock(configPath, () =>
    withForgeConfigLock(policyPath, () => migrateLocked(configPath, policyPath, options)),
  );
}

function migrateLocked(
  configPath: string,
  policyPath: string,
  options: PolicyMigrationOptions,
): PolicyMigrationResult {
  const configText = readFileOrThrow(configPath, 'config.yaml');
  const configDoc = parseDocument(configText, 'config.yaml', configPath);
  const configMap = requireTopMap(configDoc, 'config.yaml', configPath);
  const configJS = (configDoc.toJS() ?? {}) as Record<string, unknown>;
  const policyState = readYamlMapFile(policyPath);
  const policyHasContent = policyFileHasContent(policyState);

  // Seed the new policy document with whatever the owner already has there, so a
  // re-run cannot drop a key the first run wrote (`model_hosts` and the engines
  // are exactly the content that would otherwise vanish and make the re-run think
  // the files disagree). Only the content-equal case reaches a write, and that
  // case writes nothing, so the owner's comments in an existing policy file are
  // never re-flowed by this command.
  const policyDoc = new YAML.Document(policyState.exists ? structuredClone(policyState.raw) : {});
  const policyMap = requireTopMap(policyDoc, 'policy.yaml', policyPath);
  const movedKeys: string[] = [];
  const alreadyInPolicy: string[] = [];

  // 1. Whole blocks, in the order `policySchema.ts` lists them, so the policy
  //    file reads the same whatever order config.yaml was edited in.
  for (const key of POLICY_KEYS) {
    const pair = findPair(configMap, key);
    if (!pair) continue;
    if (Object.prototype.hasOwnProperty.call(policyState.raw, key)) {
      if (!deepEqual(configJS[key], policyState.raw[key])) {
        throw new Error(
          `Forge: config.yaml and policy.yaml both define "${key}" with different values\n` +
            `(${configPath} vs ${policyPath}). Forge will not guess which one you meant.\n` +
            `Edit or delete one copy, then run "Forge: Move security settings to policy.yaml" again.`,
        );
      }
      configMap.delete(key);
      alreadyInPolicy.push(key);
      continue;
    }
    const foreign = findForeignAlias(pair.value, configDoc);
    if (foreign) {
      throw new Error(
        `Forge: config.yaml "${key}" uses the anchor *${foreign}, which stays in config.yaml —\n` +
          `a YAML anchor cannot cross a file boundary. Keep "${key}" in config.yaml, or move\n` +
          `the anchor definition into policy.yaml first. Nothing was written.`,
      );
    }
    configMap.delete(key);
    policyMap.add(pair.clone(configDoc.schema));
    movedKeys.push(key);
  }

  // 2. Models: their own server programs become a named engine in policy.yaml.
  const engines = foldModelsIntoEngines(
    configDoc,
    configMap,
    policyDoc,
    policyMap,
    policyState.raw,
  );

  // 3. `model_hosts`: the hosts these models already talk to, so phase 3 does not
  //    refuse a tailnet or LAN server the owner has been using for months.
  const hosts = nonLoopbackHostsOf(configJS);
  if (hosts.length > 0 && !policyState.raw.model_hosts) {
    policyMap.set('model_hosts', hosts);
  }

  // 4. Validate the PAIR before touching the disk: this merged object is what
  //    `loadConfig` will see, so a split that would leave an unloadable pair is
  //    refused here rather than on the next reload.
  const merged = { ...(configDoc.toJS() ?? {}), ...(policyDoc.toJS() ?? {}) };
  const validated = ForgeConfigSchema.safeParse(merged);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Forge: the policy split would leave config.yaml invalid:\n${issues}\n` +
        `Nothing was written; ${configPath} and ${policyPath} are unchanged.`,
    );
  }
  const leftovers = checkConfigCrossRefs(validated.data as ForgeConfig);
  if (leftovers.length > 0) {
    throw new Error(
      `Forge: the policy split would leave ${leftovers
        .map((row) => `${row.path}: "${row.value}"`)
        .join(', ')} naming models that are not configured.\n` +
        `Nothing was written. Fix the reference in config.yaml first.`,
    );
  }

  const policyMatches = policyHasContent
    ? deepEqual(policyState.raw, policyDoc.toJS() ?? {})
    : false;
  if (policyHasContent && !policyMatches) {
    throw new Error(
      `Forge: policy.yaml already exists with different content (${policyPath}).\n` +
        `Forge does not overwrite the owner's policy file from a command: edit it yourself,\n` +
        `or move it aside and run "Forge: Move security settings to policy.yaml" again.\n` +
        `Nothing was written.`,
    );
  }

  const stamp = stampOf(options.now ?? new Date());
  const backupPath = path.join(path.dirname(configPath), `${BACKUP_PREFIX}${stamp}`);
  // The backup goes first and atomically: every failure after this point has a
  // copy of the original bytes to go back to, and the owner never has to trust
  // Forge's memory of what the file said.
  writeFileAtomicSync(backupPath, configText);
  // Policy first, then config: a crash in between leaves a key in both files,
  // which the loader names, and a re-run finishes (see `policyMatches` above).
  if (!policyMatches) writeFileAtomicSync(policyPath, policyDoc.toString({ lineWidth: 0 }));
  writeFileAtomicSync(configPath, configDoc.toString({ lineWidth: 0 }));

  return {
    configPath,
    policyPath,
    backupPath,
    movedKeys,
    alreadyInPolicy,
    engines,
    model_hosts: hosts,
    policyWritten: !policyMatches,
  };
}

/* ── models → engines ─────────────────────────────────────────────────────── */

/**
 * Give every model that names its own server programs an engine instead. The name
 * is the model's group, else `<model>-engine`; models with IDENTICAL field sets
 * share one engine — which is why engines exist at all. Twenty llama.cpp models
 * that all start the same binary become one engine plus twenty one-line edits,
 * instead of twenty copies of the same argv an owner has to keep in step by hand.
 * A second model in the same group with DIFFERENT fields cannot share the name,
 * so it becomes `<group>-2` and the result says why.
 *
 * A model that already names an engine keeps that name: a re-run after a crash
 * must not invent a second engine for the same model.
 */
function foldModelsIntoEngines(
  configDoc: YAML.Document,
  configMap: YAML.YAMLMap,
  policyDoc: YAML.Document,
  policyMap: YAML.YAMLMap,
  policyRaw: Record<string, unknown>,
): EnginePlanRow[] {
  const modelsNode = configMap.get('models', true);
  if (!modelsNode || !YAML.isSeq(modelsNode)) return [];

  /** engine name → the field set it holds and the models using it */
  const byName = new Map<string, { fields: Record<string, unknown>; models: string[] }>();
  const rows: EnginePlanRow[] = [];

  for (const item of modelsNode.items) {
    const entry = YAML.isPair(item) ? (item.value as YAML.Node) : (item as YAML.Node);
    if (!YAML.isMap(entry)) continue;
    const name = scalarText(entry.get('name', true));
    if (!name) continue;

    const execFields: Record<string, unknown> = {};
    const pairsToMove: Array<{ field: string; pair: YAML.Pair<unknown, unknown> }> = [];
    for (const field of ENGINE_EXEC_FIELDS) {
      const pair = findPair(entry, field);
      if (!pair) continue;
      execFields[field] = plainValueOf(pair.value);
      pairsToMove.push({ field, pair });
    }
    if (pairsToMove.length === 0) continue;

    const wanted =
      scalarText(entry.get('engine', true)) ??
      engineNameForModel({
        name,
        group: scalarText(entry.get('group', true)),
        groups: stringListOf(entry.get('groups', true)),
      });

    let engineName = wanted;
    const existing = byName.get(wanted);
    if (existing && !deepEqual(existing.fields, execFields)) {
      engineName = freeEngineName(byName, wanted);
      byName.set(engineName, { fields: execFields, models: [name] });
      rows.push({
        name: engineName,
        fields: Object.keys(execFields),
        models: [name],
        renamedFrom: wanted,
      });
    } else if (existing) {
      existing.models.push(name);
      const row = rows.find((r) => r.name === wanted);
      if (row) row.models.push(name);
    } else {
      byName.set(engineName, { fields: execFields, models: [name] });
      rows.push({ name: engineName, fields: Object.keys(execFields), models: [name] });
    }

    const engineMap = engineEntryMap(policyDoc, policyMap, engineName);
    for (const { field, pair } of pairsToMove) {
      const already = findPair(engineMap, field);
      if (already) {
        const inPolicy = plainValueOf(already.value);
        if (!deepEqual(inPolicy, execFields[field])) {
          const fromPolicy = policyEngineField(policyRaw, engineName, field);
          throw new Error(
            `Forge: engine "${engineName}" in policy.yaml already sets "${field}" as\n` +
              `  ${JSON.stringify(fromPolicy ?? inPolicy)}\n` +
              `but model "${name}" in config.yaml says\n` +
              `  ${JSON.stringify(execFields[field])}\n` +
              `Forge will not overwrite an engine from a model. Edit one of them, then re-run\n` +
              `"Forge: Move security settings to policy.yaml". Nothing was written.`,
          );
        }
      } else {
        engineMap.add(pair.clone(configDoc.schema));
      }
      entry.delete(field);
    }
    entry.set('engine', engineName);
  }
  return rows;
}

function engineEntryMap(doc: YAML.Document, policyMap: YAML.YAMLMap, name: string): YAML.YAMLMap {
  const enginesRaw: unknown = policyMap.get('engines', true);
  let enginesMap: YAML.YAMLMap | undefined = undefined;
  if (YAML.isMap(enginesRaw)) enginesMap = enginesRaw;
  if (!enginesMap) {
    enginesMap = new YAML.YAMLMap(doc.schema);
    policyMap.set('engines', enginesMap);
  }
  const entryRaw: unknown = enginesMap.get(name, true);
  if (YAML.isMap(entryRaw)) return entryRaw;
  const created = new YAML.YAMLMap(doc.schema);
  enginesMap.set(name, created);
  return created;
}

function freeEngineName(byName: Map<string, unknown>, base: string): string {
  let n = 2;
  while (byName.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function policyEngineField(
  policyRaw: Record<string, unknown>,
  engine: string,
  field: string,
): unknown {
  const engines = policyRaw.engines as Record<string, Record<string, unknown>> | undefined;
  return engines?.[engine]?.[field];
}

/** `20261102-063512`, local time: the owner reads this name in a directory
 *  listing and matches it to the run they just did. */
function stampOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
