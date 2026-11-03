import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editModelField, purgeModel, removeModelFromConfig } from '../../src/sidebar/modelManager/editOps';
import { referenceRemovalNote } from '../../src/config/modelReferences';

// Spreading the real module into a plain object is what makes `vi.spyOn(fs, …)`
// possible: a test that pins "exactly one write" has to count the atomic writer's
// renames, and an ESM namespace cannot be spied on directly.
vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(),
}));
import { writeConfigSafely } from '../../src/config/ConfigWriter';
import { loadConfig } from '../../src/config/ConfigLoader';
import type { ForgeConfig } from '../../src/config/types';

describe('modelManager editOps', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mm-editops-'));
    configPath = path.join(dir, 'config.yaml');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(config: Partial<ForgeConfig> = {}): void {
    writeConfigSafely(configPath, {
      models: [{ name: 'my-model', provider: 'llama.cpp', gguf_path: path.join(dir, 'a.gguf') }],
      active_model: 'my-model',
      llama_server: { binary: '/bin/llama-server' },
      ...config,
    } as ForgeConfig);
  }

  it('commits a top-level field edit, preserving comments elsewhere', () => {
    fs.writeFileSync(
      configPath,
      [
        '# hand-written note',
        'models:',
        '  - name: my-model',
        '    provider: llama.cpp',
        `    gguf_path: ${JSON.stringify(path.join(dir, 'a.gguf'))}`,
        'active_model: my-model',
        'llama_server:',
        '  binary: /bin/llama-server',
        '',
      ].join('\n'),
    );
    editModelField(configPath, 'my-model', 'short_name', 'mine');
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('# hand-written note');
    expect(loadConfig(dir).models[0].short_name).toBe('mine');
  });

  it('commits a nested dot-path field without clobbering sibling nested keys', () => {
    seed({
      models: [
        {
          name: 'my-model',
          provider: 'llama.cpp',
          gguf_path: path.join(dir, 'a.gguf'),
          sampling: { top_k: 40, temperature: 0.7 },
        },
      ],
    } as unknown as ForgeConfig);
    editModelField(configPath, 'my-model', 'sampling.top_k', 64);
    const reloaded = loadConfig(dir);
    expect(reloaded.models[0].sampling?.top_k).toBe(64);
    expect(reloaded.models[0].sampling?.temperature).toBe(0.7);
  });

  it('writes nothing when the edit produces a schema-invalid config', () => {
    seed();
    const before = fs.readFileSync(configPath, 'utf8');
    expect(() => editModelField(configPath, 'my-model', 'num_ctx', 'not-a-number')).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('removes a model entry without touching disk', () => {
    seed({
      models: [
        { name: 'my-model', provider: 'llama.cpp', gguf_path: path.join(dir, 'a.gguf') },
        { name: 'keeper', provider: 'llama.cpp', gguf_path: path.join(dir, 'b.gguf') },
      ],
      active_model: 'keeper',
    } as unknown as ForgeConfig);
    const ggufPath = path.join(dir, 'a.gguf');
    fs.writeFileSync(ggufPath, 'x');
    removeModelFromConfig(configPath, 'my-model');
    const reloaded = loadConfig(dir);
    expect(reloaded.models.find((m) => m.name === 'my-model')).toBeUndefined();
    expect(reloaded.models.find((m) => m.name === 'keeper')).toBeDefined();
    expect(fs.existsSync(ggufPath)).toBe(true);
  });

  describe('purgeModel', () => {
    it('refuses when the model is currently loaded', () => {
      seed();
      expect(() =>
        purgeModel(configPath, loadConfig(dir), 'my-model', (name) => name === 'my-model'),
      ).toThrow(/loaded\/active/);
    });

    it('refuses when the model is the active model', () => {
      seed();
      expect(() => purgeModel(configPath, loadConfig(dir), 'my-model', () => false)).toThrow(
        /loaded\/active/,
      );
    });

    it('deletes the gguf + sibling mmproj + emptied snapshot dir, then removes the entry', () => {
      const snapshotDir = path.join(dir, 'snapshot');
      fs.mkdirSync(snapshotDir);
      const ggufPath = path.join(snapshotDir, 'model.gguf');
      const mmprojPath = path.join(snapshotDir, 'mmproj-model.gguf');
      fs.writeFileSync(ggufPath, 'x');
      fs.writeFileSync(mmprojPath, 'y');
      seed({
        models: [
          { name: 'other-active', provider: 'llama.cpp', gguf_path: path.join(dir, 'other.gguf') },
          { name: 'my-model', provider: 'llama.cpp', gguf_path: ggufPath, mmproj_path: mmprojPath },
        ],
        active_model: 'other-active',
      } as unknown as ForgeConfig);
      fs.writeFileSync(path.join(dir, 'other.gguf'), 'z');

      purgeModel(configPath, loadConfig(dir), 'my-model', () => false);

      expect(fs.existsSync(ggufPath)).toBe(false);
      expect(fs.existsSync(mmprojPath)).toBe(false);
      expect(fs.existsSync(snapshotDir)).toBe(false);
      expect(loadConfig(dir).models.find((m) => m.name === 'my-model')).toBeUndefined();
    });

    it('leaves a non-empty snapshot dir in place', () => {
      const snapshotDir = path.join(dir, 'shared-snapshot');
      fs.mkdirSync(snapshotDir);
      const ggufPath = path.join(snapshotDir, 'model.gguf');
      fs.writeFileSync(ggufPath, 'x');
      fs.writeFileSync(path.join(snapshotDir, 'other-file.txt'), 'keep me');
      seed({
        models: [
          { name: 'other-active', provider: 'llama.cpp', gguf_path: path.join(dir, 'other.gguf') },
          { name: 'my-model', provider: 'llama.cpp', gguf_path: ggufPath },
        ],
        active_model: 'other-active',
      } as unknown as ForgeConfig);
      fs.writeFileSync(path.join(dir, 'other.gguf'), 'z');

      purgeModel(configPath, loadConfig(dir), 'my-model', () => false);

      expect(fs.existsSync(ggufPath)).toBe(false);
      expect(fs.existsSync(snapshotDir)).toBe(true);
    });

    it('keeps an mmproj another model still uses (U14-02)', () => {
      const ggufPath = path.join(dir, 'q4.gguf');
      const sharedMmproj = path.join(dir, 'mmproj.gguf');
      for (const file of [ggufPath, sharedMmproj, path.join(dir, 'q6.gguf')])
        fs.writeFileSync(file, 'x');
      seed({
        models: [
          { name: 'q6', provider: 'llama.cpp', gguf_path: path.join(dir, 'q6.gguf'), mmproj_path: sharedMmproj },
          { name: 'my-model', provider: 'llama.cpp', gguf_path: ggufPath, mmproj_path: sharedMmproj },
        ],
        active_model: 'q6',
      } as unknown as ForgeConfig);

      const kept = purgeModel(configPath, loadConfig(dir), 'my-model', () => false);

      expect(fs.existsSync(ggufPath)).toBe(false);
      expect(fs.existsSync(sharedMmproj)).toBe(true);
      expect(kept).toEqual([{ path: sharedMmproj, usedBy: ['q6'] }]);
    });

    it('deletes nothing when the config write fails (U14-01)', () => {
      const ggufPath = path.join(dir, 'a.gguf');
      fs.writeFileSync(ggufPath, 'x');
      seed({ active_model: undefined } as unknown as ForgeConfig);
      fs.writeFileSync(configPath, 'models: [unclosed');

      expect(() =>
        purgeModel(
          configPath,
          { models: [{ name: 'my-model', provider: 'llama.cpp', gguf_path: ggufPath }] } as ForgeConfig,
          'my-model',
          () => false,
        ),
      ).toThrow();
      expect(fs.existsSync(ggufPath)).toBe(true);
    });
  });

  /**
   * The delete used to remove only the model entry, and whatever config still
   * named it stayed behind: the laptop cloud list entry and the alias key then
   * refused every later write. The CI row here is the one that pins "exactly one
   * write that removes all three" and that the written file passes `loadConfig`.
   */
  describe('a delete cleans the references to the model', () => {
    /** Comments on both sides of every removed item: the cloud list is annotated
     *  by hand, and a delete that rewrote the file would take those notes with
     *  it. `jobs.default_model` is left in place on purpose — a delete must not
     *  guess a replacement model. */
    function seedWithReferences(): string {
      const raw = [
        '# top of the file',
        'llama_server:',
        '  binary: /bin/llama-server',
        'models:',
        '  # the entry being deleted',
        '  - name: gone-model',
        '    provider: openrouter',
        '    api_key_secret: test.ref',
        '  # keeper stays',
        '  - name: keeper',
        '    provider: openrouter',
        '    api_key_secret: test.ref',
        'active_model: keeper',
        'aliases:',
        '  # alias for the deleted model',
        '  old-alias: gone-model',
        '  # alias that stays',
        '  live-alias: keeper',
        'cloud_relay:',
        '  enabled: true',
        '  port: 8797',
        '  max_body_mb: 32',
        '  models:',
        '    # allowlisted and being deleted',
        '    - gone-model',
        '    # allowlisted and stays',
        '    - keeper',
        'jobs:',
        '  enabled: true',
        '  default_model: gone-model',
        '',
      ].join('\n');
      fs.writeFileSync(configPath, raw, 'utf8');
      return raw;
    }

    it('removes the model, the allowlist entry and the alias key in one write', () => {
      seedWithReferences();
      const renames = vi.spyOn(fs, 'renameSync');

      removeModelFromConfig(configPath, 'gone-model');

      expect(
        renames.mock.calls.filter((call) => String(call[1]) === configPath),
      ).toHaveLength(1);
      renames.mockRestore();

      const raw = fs.readFileSync(configPath, 'utf8');
      expect(raw).toContain('# top of the file');
      expect(raw).toContain('# keeper stays');
      expect(raw).toContain('# alias that stays');
      expect(raw).toContain('# allowlisted and stays');
      // What the delete owns is gone: the model entry, its alias key, its
      // allowlist line. `jobs.default_model` stays on purpose — it still names
      // the deleted model, and the loader warns about that instead of refusing
      // the file.
      expect(raw).not.toContain('- name: gone-model');
      expect(raw).not.toContain('old-alias');
      expect(raw).toContain('default_model: gone-model');
      // A documented wart, measured rather than wished away: `yaml` stores a
      // block's leading comment on the block, not on its first entry, so the
      // note above the FIRST removed entry survives as the next entry's leading
      // comment. Comments above later entries go with their entry. Nothing else
      // in the file moves.
      expect(raw).toContain('# the entry being deleted');
      expect(raw.split('\n').filter((line) => line.trim() === '# keeper stays')).toHaveLength(1);

      // The written file passes the loader — the whole point of the shared checks.
      const config = loadConfig(dir);
      expect(config.models.map((model) => model.name)).toEqual(['keeper']);
      expect(config.aliases).toEqual({ 'live-alias': 'keeper' });
      expect(config.cloud_relay?.models).toEqual(['keeper']);
      expect(config.active_model).toBe('keeper');
    });

    /** `jobs.default_model` is not rewritten by a delete: it is a choice, not a
     *  list entry. It stays and the config warning names it. */
    it('leaves the jobs model in place, pointing at what was deleted', () => {
      seedWithReferences();
      removeModelFromConfig(configPath, 'gone-model');
      const raw = fs.readFileSync(configPath, 'utf8');
      expect(raw).toContain('default_model: gone-model');
      expect(loadConfig(dir).jobs?.default_model).toBe('gone-model');
    });

    /** `cloud_relay.models` must name at least one model, so the last removal
     *  takes the whole block with it rather than leaving an empty list the
     *  schema would refuse. */
    it('drops the cloud_relay block when the last allowlisted name goes', () => {
      seedWithReferences();
      const withoutKeeper = fs
        .readFileSync(configPath, 'utf8')
        .replace('    # allowlisted and stays\n    - keeper\n', '');
      fs.writeFileSync(configPath, withoutKeeper, 'utf8');

      removeModelFromConfig(configPath, 'gone-model');

      const raw = fs.readFileSync(configPath, 'utf8');
      expect(raw).not.toContain('cloud_relay');
      const config = loadConfig(dir);
      expect(config.cloud_relay).toBeUndefined();
      expect(config.aliases).toEqual({ 'live-alias': 'keeper' });
    });

    /** `active_model` is the same case: left in place, cleared to "no model
     *  active" by the loader, never replaced by a guess. */
    it('leaves a selection naming the deleted model, and the loader clears it', () => {
      seedWithReferences();
      const rawBefore = fs
        .readFileSync(configPath, 'utf8')
        .replace('active_model: keeper', 'active_model: gone-model');
      fs.writeFileSync(configPath, rawBefore, 'utf8');

      removeModelFromConfig(configPath, 'gone-model');

      expect(fs.readFileSync(configPath, 'utf8')).toContain('active_model: gone-model');
      expect(loadConfig(dir).active_model).toBeNull();
    });

    it('the prompt names what the delete removes, and the panel shows it', () => {
      seedWithReferences();
      const note = referenceRemovalNote(loadConfig(dir), 'gone-model');
      expect(note).toContain('Also removes it from: the laptop cloud list and alias `old-alias`.');
      expect(note).toContain('Leaves the jobs model pointing at it');

      const panel = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'src', 'sidebar', 'modelManager', 'ModelManagerPanel.ts'),
        'utf8',
      );
      // Both destructive prompts must carry the note, or the user consents to a
      // write they have not been told about.
      expect(panel.match(/referenceRemovalNote\(this\.getConfig\(\), msg\.modelName\)/g)).toHaveLength(2);
    });
  });
});
