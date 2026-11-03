import { resolveModelName, splitModelProfile } from './ConfigResolver';
import type { ForgeConfig } from './types';

/**
 * The one owner of "where config.yaml names a model".
 *
 * Four config fields hold model names: `active_model`, `aliases` (each target),
 * `cloud_relay.models` (the laptop allowlist) and `jobs.default_model`. Before
 * this module each consumer had its own check, so removing one model produced
 * three different failures (the whole config refused at load, a job that died
 * with "unknown model", a silently dangling alias) and the Models panel left
 * the references behind without a word.
 *
 * A reference that names a model which is gone is NOT an error: the config
 * loads and Forge shows one warning naming every path. Only a write that
 * CREATES such a reference is refused (`ConfigWriter.updateConfigFile`), so a
 * stale name can never block an unrelated config change — that was the 2026-10-27
 * `llama-updates` failure: one leftover `cloud_relay.models` entry refused the
 * whole file, so the llama.cpp binary switch could not run.
 *
 * Adding a config field that names a model means adding it to
 * {@link MODEL_REF_FIELDS} here AND to the fixture in
 * `test/unit/ModelReferences.test.ts` (its `NON_MODEL_REF_FIELDS` list plus
 * `fixture()`), which fails on either half.
 */

/** Top-level config fields whose values name a model. */
export const MODEL_REF_FIELDS = Object.freeze(['active_model', 'aliases', 'cloud_relay', 'jobs']);

export type ModelRefKind = 'cloud_relay_model' | 'alias' | 'active_model' | 'jobs_default_model';

/** One place in config.yaml that names a model. */
export interface ModelReference {
  kind: ModelRefKind;
  /** Where it is: `cloud_relay.models[2]`, `aliases.gemma4-e4b`, `active_model`, `jobs.default_model`. */
  path: string;
  /** How the warning and the delete prompt name it, in everyday words. */
  label: string;
  /** The value exactly as written, `@profile` and all (`gemma@worker`). */
  value: string;
  /** The map key, for `aliases` rows. The `path` text alone is not safe to
   *  split when a key contains a dot, and the writer needs the exact key. */
  key?: string;
  /** Whether deleting the model should take this reference with it.
   *  `active_model` and `jobs.default_model` stay: a delete must not guess a
   *  replacement model, and Phase 1 makes a dangling one a loaded-with-warning state. */
  removedWithModel: boolean;
}

/**
 * The configured model `value` points at, or `undefined` when it points at
 * nothing configured. Resolution follows `resolveModelName`'s order (exact
 * name, exact alias key, exact short_name, then unique case/prefix/substring
 * matches), with any `@profile` suffix stripped first. An ambiguous or dangling
 * reference resolves to nothing — this never guesses between candidates, and a
 * caller that gets `undefined` reports the reference instead of failing on it.
 */
export function resolvesToConfiguredModel(config: ForgeConfig, value: string): string | undefined {
  const { base } = splitModelProfile(value);
  try {
    const name = resolveModelName(config, base);
    return config.models.some((model) => model.name === name) ? name : undefined;
  } catch {
    // Unknown, or ambiguous across two models: either way nothing is named.
    return undefined;
  }
}

/** Every place config.yaml names a model, in file order. Defensive because
 *  `ConfigWriter` calls it on a `yaml` Document's raw `toJS()`, which is not
 *  schema-validated yet. */
export function everyModelRef(config: ForgeConfig): ModelReference[] {
  const rows: ModelReference[] = [];
  const relayModels = config.cloud_relay?.models;
  if (Array.isArray(relayModels)) {
    relayModels.forEach((value, index) => {
      if (typeof value !== 'string') return;
      rows.push({
        kind: 'cloud_relay_model',
        path: `cloud_relay.models[${index}]`,
        label: 'the laptop cloud list',
        value,
        removedWithModel: true,
      });
    });
  }
  const aliases = config.aliases ?? {};
  for (const [key, value] of Object.entries(aliases)) {
    if (typeof value !== 'string') continue;
    rows.push({
      kind: 'alias',
      path: `aliases.${key}`,
      label: `alias \`${key}\``,
      value,
      key,
      removedWithModel: true,
    });
  }
  if (typeof config.active_model === 'string' && config.active_model.length > 0) {
    rows.push({
      kind: 'active_model',
      path: 'active_model',
      label: 'the active model',
      value: config.active_model,
      removedWithModel: false,
    });
  }
  const jobsDefault = config.jobs?.default_model;
  if (typeof jobsDefault === 'string' && jobsDefault.length > 0) {
    rows.push({
      kind: 'jobs_default_model',
      path: 'jobs.default_model',
      label: 'the jobs model',
      value: jobsDefault,
      removedWithModel: false,
    });
  }
  return rows;
}

/** Every place that names `name` — exactly, or through an alias key, a
 *  `@profile` suffix, a `short_name`, or a unique fuzzy match. Used by the
 *  Models panel delete, which must clean up after the model it removes. */
export function findModelReferences(config: ForgeConfig, name: string): ModelReference[] {
  return everyModelRef(config).filter(
    (row) => resolvesToConfiguredModel(config, row.value) === name,
  );
}

/** Every reference whose model is no longer configured. */
export function findLeftoverModelRefs(config: ForgeConfig): ModelReference[] {
  return everyModelRef(config).filter(
    (row) => resolvesToConfiguredModel(config, row.value) === undefined,
  );
}

/** Identity of a reference, for the "did this write create a new leftover?"
 *  comparison and the already-shown warning set: path plus value, so re-pointing
 *  an alias at a different removed model counts as a new one. */
export function modelRefKey(row: ModelReference): string {
  return `${row.path}=${row.value}`;
}

/** The single warning text for a set of leftovers: one line per path. */
export function leftoverWarningText(leftovers: ModelReference[]): string {
  const lines = leftovers.map((row) => `  • ${row.path} (${row.label}): "${row.value}"`);
  return (
    'Forge: config.yaml names models that are no longer configured:\n' +
    `${lines.join('\n')}\n` +
    'Forge loaded the config anyway and left these in place. Delete them from ' +
    'config.yaml, or re-add the model. The Models panel removes the laptop ' +
    'cloud list and alias entries along with the model.'
  );
}

/** Join labels the way English reads them: `a`, `a and b`, `a, b and c`. */
function andJoin(labels: string[]): string {
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The sentence the Models panel's confirm prompt adds to a delete: which
 * references go with the model, which stay, and whether the laptop cloud list
 * goes entirely (`cloud_relay.models` must name at least one model, so the last
 * removal takes the whole `cloud_relay` block with it). A delete that said
 * nothing used to leave the allowlist entry and the alias key pointing at a
 * model that no longer existed, and the next config write failed on them.
 */
export function referenceRemovalNote(config: ForgeConfig, name: string): string {
  const rows = findModelReferences(config, name);
  const cleaned = rows.filter((row) => row.removedWithModel);
  const left = rows.filter((row) => !row.removedWithModel);
  const relayNames = config.cloud_relay?.models ?? [];
  const relayEmptied =
    relayNames.length > 0 &&
    cleaned.filter((row) => row.kind === 'cloud_relay_model').length === relayNames.length;
  const sentences: string[] = [];
  if (cleaned.length > 0) {
    const labels = cleaned.map((row) =>
      relayEmptied && row.kind === 'cloud_relay_model'
        ? 'the laptop cloud list (it would be empty, so the whole `cloud_relay` block goes too)'
        : row.label,
    );
    sentences.push(`Also removes it from: ${andJoin(labels)}.`);
  }
  if (left.length > 0) {
    sentences.push(
      `Leaves ${andJoin(left.map((row) => row.label))} pointing at it. Forge will load ` +
        'the config and warn about it until config.yaml names a model that exists.',
    );
  }
  return sentences.join('\n');
}
