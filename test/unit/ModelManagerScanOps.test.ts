import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addScannedModels,
  buildModelConfigForPick,
  scanDirectoryForCandidates,
} from '../../src/sidebar/modelManager/scanOps';
import { writeConfigSafely } from '../../src/config/ConfigWriter';
import { loadConfig } from '../../src/config/ConfigLoader';
import type { ForgeConfig } from '../../src/config/types';

describe('modelManager scanOps', () => {
  let dir: string;
  let configPath: string;
  let scanDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mm-scanops-'));
    configPath = path.join(dir, 'config.yaml');
    scanDir = path.join(dir, 'downloads');
    fs.mkdirSync(scanDir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('dedupes scan candidates already present in config', async () => {
    const configuredPath = path.join(scanDir, 'gemma-4-27b-Q4_K_M.gguf');
    const newPath = path.join(scanDir, 'qwen3-30b-Q4_K_M.gguf');
    fs.writeFileSync(configuredPath, Buffer.alloc(16));
    fs.writeFileSync(newPath, Buffer.alloc(16));

    const config: ForgeConfig = {
      models: [{ name: 'existing', provider: 'llama.cpp', gguf_path: configuredPath }],
      active_model: 'existing',
      llama_server: { binary: '/bin/llama-server' },
    };

    const candidates = await scanDirectoryForCandidates(config, scanDir);
    const existing = candidates.find((c) => c.ggufPath === configuredPath);
    const fresh = candidates.find((c) => c.ggufPath === newPath);
    expect(existing?.alreadyConfigured).toBe(true);
    expect(fresh?.alreadyConfigured).toBe(false);
    expect(fresh?.quant).toBe('Q4_K_M');
    expect(fresh?.family).toBe('qwen3');
  });

  it('generates a gemma entry with family convention sampling when no matching group exists', () => {
    const config: ForgeConfig = {
      models: [],
      active_model: null,
      llama_server: { binary: '/bin/llama-server' },
    };
    const ggufPath = path.join(scanDir, 'gemma-4-27b-it-Q4_K_M.gguf');
    const entry = buildModelConfigForPick(config, { ggufPath, name: 'gemma-27b' });
    expect(entry.provider).toBe('llama.cpp');
    expect(entry.spawn?.num_ctx).toBeGreaterThan(0);
    expect(entry.sampling?.top_k).toBe(64);
    expect(entry.sampling?.stop).toBe('<end_of_turn>');
    expect(entry.group).toBeUndefined();
  });

  it('attaches an existing group when a same-family model already uses one', () => {
    const config: ForgeConfig = {
      models: [
        {
          name: 'gemma-existing',
          provider: 'llama.cpp',
          gguf_path: path.join(scanDir, 'gemma-4-9b-Q8_0.gguf'),
          group: 'llamacpp-gemma',
        },
      ],
      active_model: 'gemma-existing',
      groups: { 'llamacpp-gemma': { spawn: { num_ctx: 32768 } } },
      llama_server: { binary: '/bin/llama-server' },
    };
    const entry = buildModelConfigForPick(config, {
      ggufPath: path.join(scanDir, 'gemma-4-27b-Q4_K_M.gguf'),
      name: 'gemma-27b',
    });
    expect(entry.group).toBe('llamacpp-gemma');
    expect(entry.spawn).toBeUndefined();
  });

  it('suggests the sibling mmproj as mmproj_path on the generated entry', () => {
    const config: ForgeConfig = { models: [], active_model: null, llama_server: { binary: '/bin/llama-server' } };
    const ggufPath = path.join(scanDir, 'llava-Q4_K_M.gguf');
    const mmprojPath = path.join(scanDir, 'mmproj-llava.gguf');
    const entry = buildModelConfigForPick(config, { ggufPath, name: 'llava', mmprojPath });
    expect(entry.mmproj_path).toBe(mmprojPath);
  });

  it('addScannedModels writes new entries and rejects name collisions up front', () => {
    writeConfigSafely(configPath, {
      models: [{ name: 'existing', provider: 'llama.cpp', gguf_path: path.join(scanDir, 'e.gguf') }],
      active_model: 'existing',
      llama_server: { binary: '/bin/llama-server' },
    } as ForgeConfig);
    const config = loadConfig(dir);

    addScannedModels(configPath, config, [
      { ggufPath: path.join(scanDir, 'new-model-Q4_K_M.gguf'), name: 'new-model' },
    ]);
    expect(loadConfig(dir).models.map((m) => m.name)).toContain('new-model');

    expect(() =>
      addScannedModels(configPath, loadConfig(dir), [
        { ggufPath: path.join(scanDir, 'dup.gguf'), name: 'existing' },
      ]),
    ).toThrow(/already exists/);
  });
});
