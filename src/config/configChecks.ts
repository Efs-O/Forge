import { availableProfilesFor, splitModelProfile } from './ConfigResolver';
import {
  findLeftoverModelRefs,
  resolvesToConfiguredModel,
  type ModelReference,
} from './modelReferences';
import type { ForgeConfig } from './types';

/**
 * The post-schema cross-block checks a Forge config must pass, in one place so
 * the loader and the writer cannot disagree.
 *
 * `loadConfig` ran these after the Zod schema and `updateConfigFile` ran only
 * the schema, so the Models panel could write a file its own loader then
 * refused — a config that saved cleanly and broke the next window. Both now
 * call this, so no write path can produce a file `loadConfig` rejects.
 *
 * What throws here is what was always fatal: a duplicate model name, a model
 * naming an undefined profile or group, a `short_name` that collides. What
 * does NOT throw is a reference naming a model that has been deleted: those
 * are returned as leftovers, reported by the caller (`ConfigLoader` warns,
 * `ConfigWriter` refuses only when a write ADDS one). Keeping the two classes
 * apart is the whole point of this module.
 */
export function checkConfigCrossRefs(config: ForgeConfig): ModelReference[] {
  const models = Array.isArray(config.models) ? config.models : [];
  const modelNames = new Set(models.map((model) => model.name));
  const profileNames = new Set(Object.keys(config.profiles ?? {}));

  const seenNames = new Set<string>();
  for (const model of models) {
    if (seenNames.has(model.name)) {
      throw new Error(`Forge: duplicate model name "${model.name}" in config.yaml`);
    }
    seenNames.add(model.name);
  }

  for (const model of models) {
    for (const profile of model.profiles ?? []) {
      if (!profileNames.has(profile)) {
        throw new Error(
          `Forge: model "${model.name}" references unknown profile "${profile}" (available: ${[...profileNames].join(', ') || 'none'})`,
        );
      }
    }
  }

  // active_model may carry a trailing @profile (F6). A selection that names a
  // deleted model is a leftover, not an error: the caller clears it to "no
  // model active", which is the same state `active_model: none` produces.
  if (config.active_model) {
    const { profile } = splitModelProfile(config.active_model);
    const resolved = resolvesToConfiguredModel(config, config.active_model);
    if (resolved && profile && !profileNames.has(profile)) {
      throw new Error(
        `Forge: active_model "${config.active_model}" references unknown profile "${profile}" (available: ${[...profileNames].join(', ') || 'none'})`,
      );
    }
    if (resolved && profile && !availableProfilesFor(config, resolved).includes(profile)) {
      throw new Error(
        `Forge: active_model "${config.active_model}" uses a profile unavailable for model "${resolved}"`,
      );
    }
  }

  // Every alias target must resolve to a known base (+ known profile if
  // present). A target that is gone is a leftover the alias itself cannot
  // fix: `resolveModelName` reports it by name when someone uses the alias.
  for (const [key, target] of Object.entries(config.aliases ?? {})) {
    if (typeof target !== 'string') continue;
    const { base, profile } = splitModelProfile(target);
    const resolved = resolvesToConfiguredModel(config, target);
    if (!resolved) continue;
    if (profile && !profileNames.has(profile)) {
      throw new Error(
        `Forge: alias "${key}" → "${target}" references unknown profile "${profile}"`,
      );
    }
    if (profile && !availableProfilesFor(config, resolved).includes(profile)) {
      throw new Error(`Forge: alias "${key}" uses a profile unavailable for model "${base}"`);
    }
  }

  // Every model's group/groups reference must resolve to a defined group (F7).
  const groupNames = new Set(Object.keys(config.groups ?? {}));
  for (const model of models) {
    const referenced = model.groups ?? (model.group ? [model.group] : []);
    for (const name of referenced) {
      if (!groupNames.has(name)) {
        throw new Error(
          `Forge: model "${model.name}" references unknown group "${name}" (defined: ${[...groupNames].join(', ') || 'none'})`,
        );
      }
    }
  }

  // short_name must be globally unique against every model name, alias key,
  // and other short_name (F7) — the fuzzy resolver depends on this.
  const aliasKeys = Object.keys(config.aliases ?? {});
  const seenShortNames = new Map<string, string>();
  for (const model of models) {
    if (!model.short_name) continue;
    const short = model.short_name;
    if (modelNames.has(short) && short !== model.name) {
      throw new Error(
        `Forge: short_name "${short}" on model "${model.name}" collides with a configured model name`,
      );
    }
    if (aliasKeys.includes(short)) {
      throw new Error(
        `Forge: short_name "${short}" on model "${model.name}" collides with alias "${short}"`,
      );
    }
    const owner = seenShortNames.get(short);
    if (owner) {
      throw new Error(
        `Forge: short_name "${short}" is used by both "${owner}" and "${model.name}" — short_name must be unique`,
      );
    }
    seenShortNames.set(short, model.name);
  }

  return findLeftoverModelRefs(config);
}
