import * as YAML from 'yaml';
import type { ModelConfig } from './types';

/**
 * Focused, single-owner mutation helpers for editing a `yaml` `Document` in
 * place. Every helper here operates on a live `Document` node graph so
 * hand-written comments, blank lines, and key order survive for anything not
 * explicitly touched. Used by `ConfigWriter.updateConfigFile` callers (the
 * migration command, the model manager UI, and `writeConfigSafely`'s
 * reconciliation path). See docs/OWNERS.md.
 */

/** Structural (order-independent for object keys) deep equality for plain
 *  JSON-shaped values — config fields only ever contain these. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj).filter((k) => aObj[k] !== undefined);
    const bKeys = Object.keys(bObj).filter((k) => bObj[k] !== undefined);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
  }
  return false;
}

/** Get (and lazily create) the top-level `models:` sequence node. */
export function ensureModelsSeq(doc: YAML.Document): YAML.YAMLSeq {
  const existing = doc.get('models', true);
  if (existing && YAML.isSeq(existing)) return existing;
  const seq = doc.createNode([]) as YAML.YAMLSeq;
  doc.set('models', seq);
  return seq;
}

function findModelItem(doc: YAML.Document, modelName: string): YAML.YAMLMap | undefined {
  const models = ensureModelsSeq(doc);
  const item = models.items.find((it) => YAML.isMap(it) && it.get('name') === modelName);
  return item && YAML.isMap(item) ? item : undefined;
}

/** Set (or, when `value` is `undefined`, delete) a single top-level key.
 *  Explicitly wraps `value` via `doc.createNode` so the result is a real
 *  Document node graph (not a raw JS reference) — callers that need to
 *  further style/inspect the node afterward (e.g. the migrator) depend on
 *  this rather than a plain-value assignment that only resolves at
 *  stringify time. */
export function setTopLevel(doc: YAML.Document, key: string, value: unknown): void {
  if (value === undefined) doc.delete(key);
  else doc.set(key, doc.createNode(value));
}

/** Append a new entry to `models:`. Does not check for duplicate names —
 *  callers validate uniqueness via the schema/loader pass that follows. */
export function addModel(doc: YAML.Document, model: ModelConfig): void {
  const models = ensureModelsSeq(doc);
  models.add(doc.createNode(model));
}

/** Remove the model entry named `modelName`, if present. No-op otherwise. */
export function removeModel(doc: YAML.Document, modelName: string): void {
  const models = ensureModelsSeq(doc);
  const idx = models.items.findIndex((it) => YAML.isMap(it) && it.get('name') === modelName);
  if (idx >= 0) models.items.splice(idx, 1);
}

/** Set (or delete, when `value` is `undefined`) a single field on the named
 *  model entry, preserving that entry's own comments/formatting otherwise.
 *  Throws if the model does not exist. */
export function setModelField(
  doc: YAML.Document,
  modelName: string,
  field: string,
  value: unknown,
): void {
  const item = findModelItem(doc, modelName);
  if (!item) throw new Error(`Forge: model "${modelName}" not found in config`);
  if (value === undefined) item.delete(field);
  else item.set(field, value);
}

/**
 * Set (or delete, when `value === undefined`) a single field on a nested
 * object block, e.g. `voice.output.enabled`. Lazily creates the intermediate
 * maps so a config that never had an `output:` block still gains one.
 * Preserves comments/formatting on sibling keys.
 */
export function setNestedField(
  doc: YAML.Document,
  pathKeys: readonly string[],
  value: unknown,
): void {
  if (pathKeys.length === 0) throw new Error('setNestedField: empty path');
  const root = doc.contents;
  let parent: YAML.YAMLMap;
  if (root && YAML.isMap(root)) {
    parent = root;
  } else {
    parent = doc.createNode({}) as YAML.YAMLMap;
    doc.contents = parent;
  }
  for (let i = 0; i < pathKeys.length - 1; i++) {
    const key = pathKeys[i];
    const next = parent.get(key, true);
    if (next && YAML.isMap(next)) {
      parent = next;
    } else {
      const created = doc.createNode({}) as YAML.YAMLMap;
      parent.set(key, created);
      parent = created;
    }
  }
  const last = pathKeys[pathKeys.length - 1];
  if (value === undefined) parent.delete(last);
  else parent.set(last, doc.createNode(value));
}

/**
 * Delete a single nested key from a model's `spawn`/`sampling`/
 * `tool_call_limits` sub-map, removing the parent field entirely once it has
 * no keys left (never leaves a dangling empty block). No-op if the model,
 * parent field, or key is absent. Throws if the model does not exist —
 * matches `setModelField`'s contract.
 */
export function deleteModelSubField(
  doc: YAML.Document,
  modelName: string,
  parentField: string,
  subKey: string,
): void {
  const item = findModelItem(doc, modelName);
  if (!item) throw new Error(`Forge: model "${modelName}" not found in config`);
  const sub = item.get(parentField, true);
  if (!sub || !YAML.isMap(sub)) return;
  sub.delete(subKey);
  if (sub.items.length === 0) item.delete(parentField);
}

/**
 * Reconcile a whole top-level config object into `doc` field-by-field,
 * touching only keys whose value actually changed so unrelated comments
 * survive. Used by the legacy `writeConfigSafely(path, config)` call shape.
 */
export function reconcileTopLevel(doc: YAML.Document, next: Record<string, unknown>): void {
  const current = (doc.toJS() ?? {}) as Record<string, unknown>;
  const currentKeys = new Set(Object.keys(current));
  for (const key of Object.keys(next)) {
    if (key === 'models') continue;
    if (!deepEqual(current[key], next[key])) setTopLevel(doc, key, next[key]);
    currentKeys.delete(key);
  }
  for (const staleKey of currentKeys) {
    if (staleKey === 'models') continue;
    doc.delete(staleKey);
  }
}

/**
 * Reconcile `models:` array-of-objects semantics (by `name`) into `doc`,
 * only touching entries that actually differ so per-model comment blocks on
 * untouched entries survive untouched.
 */
export function reconcileModels(doc: YAML.Document, nextModels: ModelConfig[]): void {
  const models = ensureModelsSeq(doc);
  const currentByName = new Map<string, Record<string, unknown>>();
  for (const item of models.items) {
    if (YAML.isMap(item)) {
      const name = item.get('name');
      if (typeof name === 'string') currentByName.set(name, item.toJSON());
    }
  }

  const nextNames = new Set(nextModels.map((m) => m.name));
  for (const name of currentByName.keys()) {
    if (!nextNames.has(name)) removeModel(doc, name);
  }

  for (const model of nextModels) {
    const current = currentByName.get(model.name);
    if (!current) {
      addModel(doc, model);
      continue;
    }
    if (deepEqual(current, model)) continue;
    const modelObj = model as unknown as Record<string, unknown>;
    const currentKeys = new Set(Object.keys(current));
    for (const key of Object.keys(modelObj)) {
      if (!deepEqual(current[key], modelObj[key]))
        setModelField(doc, model.name, key, modelObj[key]);
      currentKeys.delete(key);
    }
    for (const staleKey of currentKeys) setModelField(doc, model.name, staleKey, undefined);
  }
}
