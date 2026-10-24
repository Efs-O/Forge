import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { writeFileAtomicSync } from '../util/atomicWrite';
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
 * against the config schema, and atomically replace the file. An optional
 * verifier runs while the config lock is still held; false or a thrown error
 * restores the exact original bytes with a second atomic write. Throws on a
 * YAML parse error, schema error, or atomic-write failure.
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

export function updateConfigFile(
  configPath: string,
  mutate: (doc: YAML.Document) => ScalarEdit[] | void,
  verify?: () => boolean,
): boolean {
  // The lock file lives beside the config, so its folder must exist first: the
  // first-run wizard offers `<workspace>/.forge` and global storage, both new.
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  return withConfigFileLock(configPath, () => {
    const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const doc = raw.trim().length > 0 ? YAML.parseDocument(raw) : new YAML.Document({});
    if (doc.errors.length > 0) {
      throw new Error(
        `Forge: config.yaml parse failed, refusing to write:\n${doc.errors
          .map((e) => `  • ${e.message}`)
          .join('\n')}`,
      );
    }
    const edits = mutate(doc);
    const text =
      edits && edits.length > 0 ? spliceScalars(raw, edits) : doc.toString({ lineWidth: 0 });
    const written = edits && edits.length > 0 ? YAML.parseDocument(text) : doc;
    if (written.errors.length > 0)
      throw new Error(
        `Forge: config.yaml edit produced invalid YAML: ${written.errors[0].message}`,
      );
    ForgeConfigSchema.parse(written.toJS() ?? {});
    atomicWrite(configPath, text);
    if (!verify) return true;
    let verified: boolean;
    try {
      verified = verify();
    } catch (error) {
      writeFileAtomicSync(configPath, raw);
      throw error;
    }
    if (!verified) writeFileAtomicSync(configPath, raw);
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

function withConfigFileLock<T>(configPath: string, operation: () => T): T {
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

/** Back up any existing file, then replace it through the shared atomic
 *  writer, which flushes before the rename. On failure the original is left
 *  untouched and the temp file is removed. */
function atomicWrite(configPath: string, contents: string): void {
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, `${configPath}.bak`);
  writeFileAtomicSync(configPath, contents);
}
