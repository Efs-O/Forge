import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { ForgeConfigSchema } from './schema';
import type { ForgeConfig } from './types';
import { reconcileModels, reconcileTopLevel } from './ConfigWriterHelpers';

export {
  addModel,
  deepEqual,
  deleteModelSubField,
  ensureModelsSeq,
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
 * against the config schema, and atomically replace the file. Throws — and
 * writes nothing — on a YAML parse error in the existing file, a mutation
 * that leaves the config schema-invalid, or an atomic-write failure.
 */
export function updateConfigFile(configPath: string, mutate: (doc: YAML.Document) => void): void {
  withConfigFileLock(configPath, () => {
    const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const doc = raw.trim().length > 0 ? YAML.parseDocument(raw) : new YAML.Document({});
    if (doc.errors.length > 0) {
      throw new Error(
        `Forge: config.yaml parse failed, refusing to write:\n${doc.errors
          .map((e) => `  • ${e.message}`)
          .join('\n')}`,
      );
    }
    mutate(doc);
    ForgeConfigSchema.parse(doc.toJS() ?? {});
    atomicWrite(configPath, doc.toString({ lineWidth: 0 }));
  });
}

function withConfigFileLock(configPath: string, operation: () => void): void {
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
    operation();
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
export function writeConfigSafely(configPath: string, config: ForgeConfig): void {
  const validated = ForgeConfigSchema.parse(config) as ForgeConfig;
  updateConfigFile(configPath, (doc) => {
    const { models, ...rest } = validated as unknown as Record<string, unknown> & {
      models: ForgeConfig['models'];
    };
    reconcileTopLevel(doc, rest);
    reconcileModels(doc, models);
  });
}

/** Write `contents` to `configPath` via temp-file + rename, backing up any
 *  existing file first. On any failure the temp file is cleaned up and the
 *  original file is left untouched. */
function atomicWrite(configPath: string, contents: string): void {
  const directory = path.dirname(configPath);
  const temporaryPath = `${configPath}.tmp`;
  const backupPath = `${configPath}.bak`;
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
  try {
    fs.writeFileSync(temporaryPath, contents, 'utf8');
    // Replace directly: deleting first leaves the live config missing if rename
    // fails. An open-file sharing violation must fail with the original intact.
    fs.renameSync(temporaryPath, configPath);
  } catch (err) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    throw err;
  }
}
