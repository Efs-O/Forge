import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { ForgeConfigSchema } from './schema';
import { isPolicyKey } from './policySchema';
import {
  POLICY_FILENAME,
  defaultPolicyPath,
  readYamlMapFile,
  assertPolicyKeys,
  assertPolicyValues,
  assertNoSharedKeys,
  assertConfigFileKeys,
  assertNoExecFieldsInConfig,
} from './PolicyLoader';
import { policyFileIsLocked, policyLockedMessage } from './policyLock';
import type { ForgeConfig } from './types';
import { checkConfigCrossRefs } from './configChecks';
import { everyModelRef } from './modelReferences';
import { reconcileModels, reconcileTopLevel } from './ConfigWriterHelpers';

export {
  addModel,
  deepEqual,
  deleteModelSubField,
  ensureModelsSeq,
  findModelItem,
  isEmptyBlock,
  removeListItem,
  removeMapEntry,
  removeModel,
  setModelField,
  setNestedField,
  setTopLevel,
} from './ConfigWriterHelpers';

/**
 * Comment-preserving config writer (F7/§2.3, §2.6). All writes go through
 * `updateConfigFile`, which loads the existing file as a `yaml` `Document`,
 * lets the caller mutate that live node graph (see ConfigWriterHelpers.ts for
 * the typed mutation surface: `setTopLevel`, `addModel`, `removeModel`,
 * `setModelField`), then validates and atomically writes the result.
 * Hand-written comments, blank lines, and key order survive untouched for
 * every part of the document the mutation didn't touch. Read-only parsing
 * elsewhere keeps using js-yaml (ConfigLoader) — this module is the sole
 * write path. See docs/OWNERS.md.
 */

/**
 * Load `configPath` (or start from an empty document if it doesn't exist
 * yet) into a `yaml` `Document`, run `mutate`, validate the resulting object
 * against the config schema AND the same post-schema cross-block checks
 * `loadConfig` runs, and atomically replace the file. An optional verifier
 * runs while the config lock is still held; false or a thrown error restores
 * the exact original bytes with a second atomic write. Throws on a YAML parse
 * error, schema error, cross-reference error, or atomic-write failure.
 *
 * A reference naming a model that has been deleted is NOT refused here: it was
 * already in the file, and refusing it would let one stale name block every
 * unrelated config change (the 2026-10-27 `llama-updates` failure — a leftover
 * `cloud_relay.models` entry refused the whole file, so the llama.cpp binary
 * switch could not run). What IS refused is a write that INTRODUCES such a
 * name, so the writer can never leave behind what the loader only tolerates
 * with a warning. A name the file already mentioned is not introduced, which is
 * what lets a model delete leave `active_model` and `jobs.default_model` behind
 * instead of guessing a replacement model.
 *
 * A mutate that only changes existing scalars should return them as
 * `ScalarEdit`s instead of setting them: those are spliced into the source
 * text, so every other byte survives. `doc.toString()` re-pads flow lists
 * (`[0, 1]` becomes `[ 0, 1 ]`) and drops a replaced scalar's trailing comment.
 */
export interface ScalarEdit {
  node: YAML.Scalar;
  value: string | number;
}

export interface ForgeWriteOptions {
  /** `~/.forge/policy.yaml` by default; a fixture copy in tests. */
  policyPath?: string;
  /** Which of the two files this write replaces. `config` (the default) means
   *  the first argument is `config.yaml`, as it always was; `policy` means the
   *  same `config.yaml` path is still passed — the pair is validated together, so
   *  a write to one file needs to know what the other holds. */
  target?: 'config' | 'policy';
}

/**
 * Load `configPath` (or start from an empty document if it doesn't exist
 * yet) into a `yaml` `Document`, run `mutate`, validate the resulting object
 * against the config schema AND the same post-schema cross-block checks
 * `loadConfig` runs, and atomically replace the file. An optional verifier
 * runs while the config lock is still held; false or a thrown error restores
 * the exact original bytes with a second atomic write. Throws on a YAML parse
 * error, schema error, cross-reference error, or atomic-write failure.
 *
 * The PAIR is what gets validated: `~/.forge/policy.yaml` is read alongside
 * `config.yaml` even when the write touches only one of them, because a key in
 * both files is a load error (`PolicyLoader.ts`) and a writer that looked only at
 * its own file could create exactly that state and still report success. The same
 * is true of phase 3's two config-side rules: a writer that only knew it was
 * "just" editing config.yaml could put `permissions`, or a model's `start_command`,
 * back into the file an agent owns, and the owner would find out by the config
 * refusing to load the next time anything read it.
 */
export function updateConfigFile(
  configPath: string,
  mutate: (doc: YAML.Document) => ScalarEdit[] | void,
  verify?: () => boolean,
  options: ForgeWriteOptions = {},
): boolean {
  const policyPath = options.policyPath ?? defaultPolicyPath();
  const writingPolicy = (options.target ?? 'config') === 'policy';
  const targetPath = writingPolicy ? policyPath : configPath;
  const otherPath = writingPolicy ? configPath : policyPath;
  const targetLabel = writingPolicy ? 'policy.yaml' : 'config.yaml';
  // A locked policy file is refused here, before anything is read or written, rather
  // than half-way through: `atomicWrite` works by renaming a new file over the
  // target, and on Windows a folder that grants "delete child" lets that rename
  // succeed even against a file this user may only read — measured on this machine,
  // where `Set-Content` failed and `fs.renameSync` over the same file did not. So
  // the ACL alone would let Forge change a policy the owner had just protected, and
  // the refusal would arrive as `EPERM: rename` naming a temp file the owner has
  // never seen. Asking first is also what keeps the lock meaningful: the code the
  // policy governs cannot use a Forge feature as a proxy for editing it.
  if (writingPolicy && policyFileIsLocked(policyPath)) {
    throw new Error(policyLockedMessage(policyPath));
  }
  // The lock file lives beside the file being written, so its folder must exist
  // first: the first-run wizard offers `<workspace>/.forge` and global storage,
  // both new, and `~/.forge` is created by the migration the same way.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  return withForgeConfigLock(targetPath, () => {
    const raw = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    const doc = raw.trim().length > 0 ? YAML.parseDocument(raw) : new YAML.Document({});
    if (doc.errors.length > 0) {
      throw new Error(
        `Forge: ${targetLabel} parse failed, refusing to write:\n${doc.errors
          .map((e) => `  • ${e.message}`)
          .join('\n')}`,
      );
    }
    const targetBefore = (doc.toJS() ?? {}) as Record<string, unknown>;
    const otherState = readYamlMapFile(otherPath);
    const otherBefore = otherState.raw;
    const before = { ...otherBefore, ...targetBefore } as unknown as ForgeConfig;
    // Names this file already mentioned: its model entries plus every field that
    // points at a model. A write may re-mention a name it already knew — that is
    // exactly what deleting a model does to `active_model` and
    // `jobs.default_model`, which a delete must leave in place rather than guess
    // a replacement for. What a write may NOT do is introduce a name that points
    // at nothing: that is how a stale reference gets into a config file, and on
    // 2026-10-27 one of them blocked every config write.
    const knownBefore = new Set<string>([
      ...(Array.isArray(before.models) ? before.models.map((model) => model.name) : []),
      ...everyModelRef(before).map((row) => row.value),
    ]);
    const edits = mutate(doc);
    const text =
      edits && edits.length > 0 ? spliceScalars(raw, edits) : doc.toString({ lineWidth: 0 });
    const written = edits && edits.length > 0 ? YAML.parseDocument(text) : doc;
    if (written.errors.length > 0)
      throw new Error(
        `Forge: ${targetLabel} edit produced invalid YAML: ${written.errors[0].message}`,
      );
    const targetAfter = (written.toJS() ?? {}) as Record<string, unknown>;
    if (writingPolicy) {
      // A policy.yaml write may not smuggle a config.yaml-only key in: it would
      // validate against the merged schema, load, and read as if an agent could
      // not edit a key it can in fact edit.
      const state = { path: policyPath, exists: true, raw: targetAfter };
      assertPolicyKeys(state);
      assertPolicyValues(state);
    }
    assertNoSharedKeys(
      { path: configPath, exists: true, raw: writingPolicy ? otherBefore : targetAfter },
      { path: policyPath, exists: true, raw: writingPolicy ? targetAfter : otherBefore },
    );
    // Phase 3's config-side rules, run on the pair as this write would leave it. A
    // programmatic writer must not be able to put a policy key, or a program Forge
    // runs, back into the file an agent owns: that is exactly the state the loader
    // refuses, and a write that reported success while producing it would leave the
    // owner with a config that stops loading later. The shared-key check above runs
    // first because "you are mid-migration, run it again" is the more specific
    // thing to say than "this key belongs in the other file".
    const policyPresent = writingPolicy || otherState.exists;
    const configAfter = {
      path: configPath,
      exists: true,
      raw: writingPolicy ? otherBefore : targetAfter,
    };
    const policyAfter = {
      path: policyPath,
      exists: policyPresent,
      raw: writingPolicy ? targetAfter : otherBefore,
    };
    assertConfigFileKeys(configAfter, policyAfter);
    assertNoExecFieldsInConfig(configAfter, policyAfter);
    const validated = ForgeConfigSchema.parse({
      ...otherBefore,
      ...targetAfter,
    }) as ForgeConfig;
    // The checks `loadConfig` runs after the schema, so a write can never
    // produce a file the loader would refuse. A reference naming a deleted model
    // passes when the file already knew that name (load tolerates it with a
    // warning); a name the edit introduced is refused, naming the path, because
    // the writer is what put it there.
    const introducedLeftovers = checkConfigCrossRefs(validated).filter(
      (row) => !knownBefore.has(row.value),
    );
    if (introducedLeftovers.length > 0) {
      throw new Error(
        `Forge: ${targetLabel} edit would leave ${introducedLeftovers
          .map((row) => `${row.path} (${row.label}): "${row.value}"`)
          .join(', ')} naming models that are not configured. Change the model\n` +
          'entry and the reference in the same edit, or remove the reference.',
      );
    }
    atomicWrite(targetPath, text);
    if (!verify) return true;
    let verified: boolean;
    try {
      verified = verify();
    } catch (error) {
      writeFileAtomicSync(targetPath, raw);
      throw error;
    }
    if (!verified) writeFileAtomicSync(targetPath, raw);
    return verified;
  });
}

function spliceScalars(raw: string, edits: ScalarEdit[]): string {
  const spans = edits.map(({ node, value }) => {
    if (!node.range) throw new Error('Forge: config value has no source position to edit.');
    return { start: node.range[0], end: node.range[1], text: scalarSource(node, value) };
  });
  spans.sort((a, b) => b.start - a.start);
  return spans.reduce(
    (text, span) => text.slice(0, span.start) + span.text + text.slice(span.end),
    raw,
  );
}

/** Source text for `value`, keeping the replaced scalar's quote style. */
function scalarSource(node: YAML.Scalar, value: string | number): string {
  if (typeof value === 'number') return String(value);
  if (node.type === YAML.Scalar.QUOTE_SINGLE) return `'${value.replace(/'/g, "''")}'`;
  const plainSafe = /^[A-Za-z0-9_./-]+$/.test(value) && YAML.parse(value) === value;
  if (node.type === YAML.Scalar.PLAIN && plainSafe) return value;
  return JSON.stringify(value);
}

/**
 * Hold the lock beside `configPath` for the whole read-and-write, so two windows
 * cannot interleave a config change. Exported because `policyMigration.ts` needs
 * the same lock: a migration that read `config.yaml`, let go, and wrote later
 * would overwrite whatever another window put there in between — losing a
 * llama.cpp binary switch, or re-adding a key the migration had just moved out.
 */
export function withForgeConfigLock<T>(configPath: string, operation: () => T): T {
  const lockPath = `${configPath}.lock`;
  const started = Date.now();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 60_000)
          fs.rmSync(lockPath, { force: true });
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      if (Date.now() - started >= 15_000)
        throw new Error(`Forge config lock timed out: ${lockPath}`);
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  try {
    return operation();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

/**
 * Validate, back up, and atomically replace a Forge YAML config from a full
 * `ForgeConfig` object (legacy whole-object call shape used by the setup
 * wizards). Internally reconciles field-by-field against any existing file
 * so comments/order on untouched keys and untouched model entries survive.
 */
export function writeConfigSafely(
  configPath: string,
  config: ForgeConfig,
  options: ForgeWriteOptions = {},
): void {
  const validated = ForgeConfigSchema.parse(config) as ForgeConfig;
  const policyPath = options.policyPath ?? defaultPolicyPath();
  const policyState = readYamlMapFile(policyPath);
  const { models, ...rest } = validated as unknown as Record<string, unknown> & {
    models: ForgeConfig['models'];
  };
  const toPolicy: Record<string, unknown> = {};
  const toConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (isPolicyKey(key) && policyState.exists) {
      toPolicy[key] = value;
    } else toConfig[key] = value;
  }
  // Policy first, then config — the order the migration writes in, so a whole-
  // object write that dies half-way leaves a pair the loader can name rather than
  // one where a key quietly exists in both files and the reader's read order
  // decides which value won. Before the owner migrates there is no policy file, so
  // `toPolicy` stays empty and this is exactly one call, exactly as it was.
  if (Object.keys(toPolicy).length > 0) {
    updateConfigFile(configPath, (doc) => reconcileTopLevel(doc, toPolicy), undefined, {
      policyPath,
      target: 'policy',
    });
  }
  updateConfigFile(
    configPath,
    (doc) => {
      reconcileTopLevel(doc, toConfig);
      reconcileModels(doc, models);
    },
    undefined,
    { policyPath, target: 'config' },
  );
}

/**
 * Which of the two files a write to `key` must go to.
 *
 * Phase 3 settled it: once `~/.forge/policy.yaml` exists, every policy key goes
 * there and `config.yaml` may not hold one at all (`assertConfigFileKeys`), so a
 * writer that put a new policy key into config.yaml would report success and leave
 * the owner with a file the loader refuses. Before the owner runs the migration
 * there is no policy file, so a policy key has to go where it has always gone —
 * config.yaml, which is also the file `ownerPaths.ts` keeps owner-only while that
 * is the case. A key that is not a policy key always went to config.yaml and still
 * does, and the whole-object writers (`writeConfigSafely`, `desktopShare.ts`) route
 * their own key lists through this same question rather than deciding separately.
 */
export function forgeFileForKey(key: string, options: ForgeWriteOptions = {}): 'config' | 'policy' {
  if (!isPolicyKey(key)) return 'config';
  const policyPath = options.policyPath ?? defaultPolicyPath();
  return fs.existsSync(policyPath) ? 'policy' : 'config';
}

/** Run `mutate` against the file that owns `key` today. The caller still passes
 *  `config.yaml`'s path, because the pair is validated together and a writer that
 *  only knew its own half could leave a duplicate key behind.
 *
 *  Every caller of this is a programmatic writer of a policy key, and each one is
 *  listed in the commit message as `docs/plans/SECURITY_SIMPLIFICATION_PLAN.md` §3
 *  requires: `remoteCommands.ts` and `remoteRuntimeSetup.ts` (`remote`),
 *  `RemoteRuntime.ts` (`voice`), `cliAgentGate.ts` (`jobs`), `llamacppIo.ts`
 *  (`llama_server`), `desktopShare.ts`/`desktopConnect.ts` (`control_server`,
 *  `model_starter`, `cloud_relay`), `ChatMode.ts` (an engine's `start_command`).
 *  From phase 3 each of those writes lands in policy.yaml once the file exists, so
 *  a locked policy file refuses them all with the unlock command named — which is
 *  the point, and `atomicWrite` below is the one place that says it.
 */
export function updateForgeKeyFile(
  configPath: string,
  key: string,
  mutate: (doc: YAML.Document) => ScalarEdit[] | void,
  options: ForgeWriteOptions = {},
): boolean {
  return updateConfigFile(configPath, mutate, undefined, {
    ...options,
    target: forgeFileForKey(key, options),
  });
}

/** Add owner-clicked `approvals.always` entries through the same routed,
 *  validated and atomic writer as every other policy-key edit. The caller passes
 *  the config path; `updateForgeKeyFile` writes policy.yaml once it exists and
 *  names `Unlock policy.yaml` when its owner lock refuses the write. */
export function addApprovalAlwaysRules(
  configPath: string,
  rules: readonly { key: string; workspace: string }[],
  options: ForgeWriteOptions = {},
): boolean {
  if (rules.length === 0) return true;
  return updateForgeKeyFile(
    configPath,
    'approvals',
    (doc) => {
      const root = doc.get('approvals', true);
      if (!root) {
        doc.set('approvals', doc.createNode({ always: rules }));
        return;
      }
      if (!YAML.isMap(root)) throw new Error('Forge: approvals in policy.yaml must be a map.');
      const always = root.get('always', true);
      if (!always) {
        root.set('always', doc.createNode(rules));
        return;
      }
      if (!YAML.isSeq(always))
        throw new Error('Forge: approvals.always in policy.yaml must be a list.');
      for (const rule of rules) {
        const exists = always.items.some(
          (item) =>
            YAML.isMap(item) &&
            item.get('key') === rule.key &&
            item.get('workspace') === rule.workspace,
        );
        if (!exists) always.add(doc.createNode(rule));
      }
    },
    options,
  );
}

/** Back up any existing file, then replace it through the shared atomic
 *  writer, which flushes before the rename. On failure the original is left
 *  untouched and the temp file is removed. */
function atomicWrite(configPath: string, contents: string): void {
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, `${configPath}.bak`);
  try {
    writeFileAtomicSync(configPath, contents);
  } catch (err) {
    // The pre-write check above usually catches a locked policy file first. This is
    // the backstop for the cases it cannot see: a POSIX lock (the write bits), a
    // folder that does not grant delete-child, or a permission change made between
    // the check and the write. Raw EACCES text names a temp file the owner has never
    // seen and reads as a broken disk rather than as the lock they chose an hour ago.
    if (path.basename(configPath) === POLICY_FILENAME && isPermissionDenied(err)) {
      throw new Error(
        `${policyLockedMessage(configPath)}\n(The file system refused it as well: ${(err as NodeJS.ErrnoException).code}.)`,
      );
    }
    throw err;
  }
}

function isPermissionDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}
