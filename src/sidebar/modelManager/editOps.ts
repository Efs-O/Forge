import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import type { ForgeConfig } from '../../config/types';
import { updateConfigFile, removeModel, setModelField } from '../../config/ConfigWriter';
import { expandAlias, splitModelProfile } from '../../config/ConfigResolver';

/**
 * Write-path operations for the Model Manager (F7/§2.3): field edit,
 * remove-from-config, and purge (config + disk). Every write goes through
 * `ConfigWriter.updateConfigFile`, which validates via Zod before anything
 * touches disk — an invalid edit throws here and writes nothing. See
 * docs/OWNERS.md.
 */

function setNestedPath(
  obj: Record<string, unknown>,
  pathParts: string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = pathParts;
  if (rest.length === 0) {
    const next = { ...obj };
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const nested = (obj[head] ?? {}) as Record<string, unknown>;
  return { ...obj, [head]: setNestedPath(nested, rest, value) };
}

/** Commit one field edit. `field` may be a dot-path into a nested object
 *  (e.g. `sampling.temperature`) — the whole top-level object is rewritten so
 *  ConfigWriterHelpers' per-field diffing still preserves untouched siblings'
 *  comments/order. Throws (writes nothing) on an unknown model or a schema-
 *  invalid resulting config. */
export function editModelField(
  configPath: string,
  modelName: string,
  field: string,
  value: unknown,
): void {
  updateConfigFile(configPath, (doc) => {
    const parts = field.split('.');
    if (parts.length === 1) {
      setModelField(doc, modelName, field, value);
      return;
    }
    const models = ((doc.toJS() as { models?: Array<Record<string, unknown>> } | null)?.models ??
      []) as Array<Record<string, unknown>>;
    const current = models.find((m) => m['name'] === modelName);
    if (!current) throw new Error(`Forge: model "${modelName}" not found in config`);
    const [top, ...rest] = parts;
    const currentTop = (current[top] ?? {}) as Record<string, unknown>;
    const nextTop = setNestedPath(currentTop, rest, value);
    setModelField(doc, modelName, top, Object.keys(nextTop).length > 0 ? nextTop : undefined);
  });
}

/** Remove a model entry from config.yaml only — no disk deletion. Caller
 *  (the panel) is responsible for the native confirmation prompt. */
export function removeModelFromConfig(configPath: string, modelName: string): void {
  updateConfigFile(configPath, (doc: YAML.Document) => removeModel(doc, modelName));
}

/** Delete `target` if it exists; swallows fs errors (best-effort — caller
 *  already confirmed the destructive intent, and a missing/locked sibling
 *  file must not abort the rest of the purge). */
function deleteFileBestEffort(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // best-effort
  }
}

/** Delete one orphan GGUF (no config entry involved). Throws on failure —
 *  unlike the sibling-deletion inside `purgeModel`, this is the file's only
 *  deletion attempt so the caller should see a real error, not silence. */
export function purgeOrphanFile(target: string): void {
  fs.rmSync(target, { force: true });
}

/**
 * Purge a model: delete its gguf + sibling mmproj + (if left empty) the
 * parent snapshot directory, then remove the config entry (Q7). Refuses
 * while the model is loaded or currently active (Q7) — throws without
 * touching disk or config in that case.
 */
export function purgeModel(
  configPath: string,
  config: ForgeConfig,
  modelName: string,
  isLoaded: (name: string) => boolean,
): void {
  const model = config.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`Forge: model "${modelName}" not found in config`);

  const activeBase = config.active_model
    ? splitModelProfile(expandAlias(config, config.active_model)).base
    : null;
  if (isLoaded(modelName) || activeBase === modelName) {
    throw new Error(`Forge: "${modelName}" is currently loaded/active — unload it before purging.`);
  }

  if (model.gguf_path) deleteFileBestEffort(model.gguf_path);
  if (model.mmproj_path) deleteFileBestEffort(model.mmproj_path);

  if (model.gguf_path) {
    const dir = path.dirname(model.gguf_path);
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // best-effort — leaving an empty dir behind is harmless
    }
  }

  removeModelFromConfig(configPath, modelName);
}
