import { describe, expect, it } from 'vitest';
import {
  MODEL_REF_FIELDS,
  everyModelRef,
  findLeftoverModelRefs,
  findModelReferences,
  modelRefKey,
  referenceRemovalNote,
  resolvesToConfiguredModel,
} from '../../src/config/modelReferences';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';

/**
 * Every top-level `config.yaml` field that does NOT name a model. This list and
 * `MODEL_REF_FIELDS` together must equal the schema's top-level keys — the drift
 * test below fails when a field is added to `ForgeConfigSchema` until its author
 * says which side it belongs on. A field that can hold a model name goes in
 * `MODEL_REF_FIELDS` AND in `modelReferences.ts`'s walk, so the config warning,
 * the Models panel delete and the writer's "did this edit create a stale
 * reference?" check all see it.
 */
const NON_MODEL_REF_FIELDS = [
  'models',
  'groups',
  'defaults',
  'profiles',
  'llama_server',
  // `permissions:` holds gates, timeouts and path lists. No key under it can
  // name a model, so a model delete leaves nothing stale there.
  'permissions',
  // `approvals:` holds owner-only keys for policy.yaml; none can name a model.
  'approvals',
  // `engines` names programs Forge runs and `model_hosts` names hosts: neither
  // can hold a model name, so a model delete leaves nothing stale behind in
  // either. Both came in with the policy split (`src/config/policySchema.ts`).
  'engines',
  'model_hosts',
  'shared_runtime',
  'search',
  'embeddings',
  'video',
  // `monitor` is only a local UPS spec, not a model reference.
  'monitor',
  'voice',
  'image_generation',
  'media',
  // `remote_media:` carries one boolean and names no model: the desktop to ask
  // is `groups['desktop-relay'].endpoint`, and `groups` is judged above.
  'remote_media',
  'model_starter',
  'agent_bus',
  'agent_links',
  'image_search',
  'log_level',
  'model_dirs',
  'extra_file_roots',
  'templates_dir',
  'custom_instructions',
  'forge_instructions',
  'strip_thinking_channels',
  'max_simultaneous_models',
  'max_cli_agents',
  'cli_idle_timeout_ms',
  'ollama',
  'auto_compact',
  'elapsed_time_note',
  // `event_reminders:` holds one boolean per event; none can name a model.
  'event_reminders',
  'record_requests',
  'control_server',
  'remote',
  'browser',
  'fetch',
  'exec',
  // `tools:` names no model: it is the file-length warning, whose values are
  // line counts and globs. Listed here so a new top-level key still has to be
  // judged as naming-a-model or not, which is what this test forces.
  'tools',
  // `skills:` names no model either: its only key is `enabled`, and the roots
  // are fixed folders, not configured ones (`src/skills/discover.ts`).
  'skills',
  'mcp_servers',
];

/** A config whose every model-naming field points at the same model. */
function fixture(): ForgeConfig {
  return {
    models: [
      { name: 'keep', provider: 'llama.cpp', gguf_path: '/models/keep.gguf', short_name: 'kp' },
      { name: 'keep-cloud', provider: 'openrouter', api_key_secret: 'test.ref' },
    ],
    active_model: 'keep-cloud',
    aliases: { 'laptop-alias': 'keep-cloud' },
    cloud_relay: { enabled: true, port: 8797, max_body_mb: 32, models: ['keep-cloud'] },
    jobs: { enabled: true, default_model: 'keep-cloud' },
    llama_server: { binary: '/bin/llama-server' },
  } as ForgeConfig;
}

describe('findModelReferences', () => {
  it('lists every field that names the model, with what a delete should do', () => {
    const rows = findModelReferences(fixture(), 'keep-cloud');
    expect(rows.map((row) => row.path).sort()).toEqual([
      'active_model',
      'aliases.laptop-alias',
      'cloud_relay.models[0]',
      'jobs.default_model',
    ]);
    expect(rows.map((row) => `${row.path} ${row.label} ${row.removedWithModel}`).sort()).toEqual([
      'active_model the active model false',
      'aliases.laptop-alias alias `laptop-alias` true',
      'cloud_relay.models[0] the laptop cloud list true',
      'jobs.default_model the jobs model false',
    ]);
  });

  /** A delete removes the allowlist entry and the alias key, but never the
   *  active model or the jobs model: those are choices, and guessing a
   *  replacement is worse than the warning Phase 1 added. */
  it('marks only the list and alias entries as removed with the model', () => {
    const rows = findModelReferences(fixture(), 'keep-cloud');
    expect(
      rows
        .filter((row) => row.removedWithModel)
        .map((row) => row.kind)
        .sort(),
    ).toEqual(['alias', 'cloud_relay_model']);
  });

  it('follows a @profile suffix, an alias key and a short_name', () => {
    const config = {
      ...fixture(),
      profiles: { main: { think: true } },
      aliases: { 'laptop-alias': 'keep-cloud', 'short-alias': 'kp' },
    } as ForgeConfig;
    // `active_model` may carry a profile the delete must not lose sight of.
    config.active_model = 'keep-cloud@main';
    expect(
      findModelReferences(config, 'keep-cloud')
        .map((row) => row.path)
        .sort(),
    ).toEqual([
      'active_model',
      'aliases.laptop-alias',
      'cloud_relay.models[0]',
      'jobs.default_model',
    ]);
    // An alias whose target is written as another model's short_name is still a
    // reference to that model: the delete has to clean it up too.
    expect(findModelReferences(config, 'keep').map((row) => row.path)).toEqual([
      'aliases.short-alias',
    ]);
  });

  it('names nothing for a model no field refers to', () => {
    expect(findModelReferences(fixture(), 'nobody')).toEqual([]);
  });
});

describe('findLeftoverModelRefs', () => {
  it('reports every reference whose model is gone, and only those', () => {
    const config = fixture();
    config.models = [{ name: 'keep', provider: 'llama.cpp', gguf_path: '/models/keep.gguf' }];
    const leftovers = findLeftoverModelRefs(config);
    expect(leftovers.map((row) => row.path).sort()).toEqual([
      'active_model',
      'aliases.laptop-alias',
      'cloud_relay.models[0]',
      'jobs.default_model',
    ]);
    expect(leftovers.every((row) => row.value === 'keep-cloud')).toBe(true);
  });

  it('leaves a reference that still resolves alone', () => {
    const config = fixture();
    config.cloud_relay = {
      enabled: true,
      port: 8797,
      max_body_mb: 32,
      models: ['keep-cloud', 'gone-model'],
    };
    expect(findLeftoverModelRefs(config).map((row) => row.path)).toEqual(['cloud_relay.models[1]']);
  });

  /** `ConfigWriter` snapshots this on a `yaml` Document's raw `toJS()`, which is
   *  not schema-validated yet: a hand-edited file can hold anything. Reading
   *  references must never throw on that, or a write would fail before it could
   *  even report what is wrong with the file. */
  it('never throws on the unvalidated document the writer snapshots it on', () => {
    expect(findLeftoverModelRefs({} as ForgeConfig)).toEqual([]);
    expect(
      findLeftoverModelRefs({ active_model: 'anything' } as unknown as ForgeConfig),
    ).toHaveLength(1);
    expect(() =>
      findLeftoverModelRefs({
        aliases: 'not-a-map',
        cloud_relay: { models: 'not-an-array' },
        jobs: { default_model: 42 },
        permissions: 'not-a-block',
      } as unknown as ForgeConfig),
    ).not.toThrow();
    expect(
      findLeftoverModelRefs({
        aliases: { 'a-alias': 42 },
      } as unknown as ForgeConfig),
    ).toEqual([]);
  });
});

describe('resolvesToConfiguredModel', () => {
  it('resolves exact names, profiles, alias keys and short_names', () => {
    const config = { ...fixture(), profiles: { main: { think: true } } };
    expect(resolvesToConfiguredModel(config, 'keep')).toBe('keep');
    expect(resolvesToConfiguredModel(config, 'keep@main')).toBe('keep');
    expect(resolvesToConfiguredModel(config, 'laptop-alias')).toBe('keep-cloud');
    expect(resolvesToConfiguredModel(config, 'kp')).toBe('keep');
  });

  it('resolves to nothing for a removed model, an unknown name or an ambiguity', () => {
    expect(resolvesToConfiguredModel(fixture(), 'gone-model')).toBeUndefined();
    expect(resolvesToConfiguredModel(fixture(), 'nobody')).toBeUndefined();
    const ambiguous = {
      models: [
        { name: 'alpha-one', provider: 'llama.cpp', gguf_path: '/m1.gguf' },
        { name: 'alpha-two', provider: 'llama.cpp', gguf_path: '/m2.gguf' },
      ],
      active_model: null,
      llama_server: { binary: 'llama-server' },
    } as ForgeConfig;
    // `alpha` matches both models: naming either one would be a guess, so it
    // resolves to nothing and the caller reports the reference instead.
    expect(resolvesToConfiguredModel(ambiguous, 'alpha')).toBeUndefined();
  });
});

describe('referenceRemovalNote', () => {
  it('says the cloud_relay block goes with its last name', () => {
    const note = referenceRemovalNote(fixture(), 'keep-cloud');
    expect(note).toContain(
      'the laptop cloud list (it would be empty, so the whole `cloud_relay` block goes too)',
    );
    expect(note).toContain(
      'Leaves the active model and the jobs model pointing at it. Forge will load ',
    );
  });

  it('says nothing when no field refers to the model', () => {
    expect(referenceRemovalNote(fixture(), 'nobody')).toBe('');
  });
});

describe('every model-naming config field is known', () => {
  it('the known fields plus the ordinary ones are exactly the schema top-level keys', () => {
    const schemaKeys = Object.keys(ForgeConfigSchema.shape).sort();
    expect([...MODEL_REF_FIELDS, ...NON_MODEL_REF_FIELDS].sort()).toEqual(schemaKeys);
    expect(new Set([...MODEL_REF_FIELDS, ...NON_MODEL_REF_FIELDS]).size).toEqual(
      MODEL_REF_FIELDS.length + NON_MODEL_REF_FIELDS.length,
    );
  });

  it('the fixture puts the model in every field MODEL_REF_FIELDS claims, and nowhere else', () => {
    const config = fixture();
    expect(ForgeConfigSchema.safeParse(config).success).toBe(true);
    expect(
      findModelReferences(config, 'keep-cloud')
        .map((row) => row.path.split('.')[0])
        .sort(),
    ).toEqual([...MODEL_REF_FIELDS].sort());
    for (const field of NON_MODEL_REF_FIELDS) {
      // `models:` is in the ordinary list because it DEFINES models rather than
      // pointing at one, so its own names are expected there.
      if (field === 'models') continue;
      expect(JSON.stringify((config as Record<string, unknown>)[field] ?? null)).not.toContain(
        'keep-cloud',
      );
    }
  });

  it('a reference is identified by path and value, so re-pointing it is a new one', () => {
    const config = fixture();
    const before = findLeftoverModelRefs(config);
    config.models = [];
    const after = findLeftoverModelRefs(config);
    expect(before).toEqual([]);
    expect(after.map((row) => modelRefKey(row)).sort()).toEqual([
      'active_model=keep-cloud',
      'aliases.laptop-alias=keep-cloud',
      'cloud_relay.models[0]=keep-cloud',
      'jobs.default_model=keep-cloud',
    ]);
    expect(after.every((row) => before.some((old) => modelRefKey(old) === modelRefKey(row)))).toBe(
      false,
    );
    expect(everyModelRef(config).length).toBe(4);
  });
});
