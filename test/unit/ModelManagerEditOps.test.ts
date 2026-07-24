import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editModelField, purgeModel, removeModelFromConfig } from '../../src/sidebar/modelManager/editOps';
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

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
  });
});
