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

  // Validate the mutated document before anything touches disk — a mutation
  // that produces an invalid config throws here and nothing is written.
  ForgeConfigSchema.parse(doc.toJS() ?? {});

  const output = doc.toString({ lineWidth: 0 });
  atomicWrite(configPath, output);
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
    // Windows rename does not replace an existing file. The backup remains the
    // recovery point if the final replacement is interrupted.
    if (fs.existsSync(configPath)) fs.rmSync(configPath, { force: true });
    fs.renameSync(temporaryPath, configPath);
  } catch (err) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    throw err;
  }
}
