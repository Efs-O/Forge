import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModelManagerState } from '../../src/sidebar/modelManager/modelSnapshot';
import type { ForgeConfig } from '../../src/config/types';

describe('buildModelManagerState', () => {
  let dir: string;
  let configPath: string;
  let ggufPath: string;
  let mmprojPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mm-snapshot-'));
    configPath = path.join(dir, 'config.yaml');
    ggufPath = path.join(dir, 'model.gguf');
    mmprojPath = path.join(dir, 'mmproj-model.gguf');
    fs.writeFileSync(ggufPath, Buffer.alloc(1024, 1));
    fs.writeFileSync(mmprojPath, Buffer.alloc(256, 1));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function baseConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
    return {
      models: [
        {
          name: 'gemma-local',
          provider: 'llama.cpp',
          gguf_path: ggufPath,
          mmproj_path: mmprojPath,
          group: 'llamacpp-gemma',
        },
        {
          name: 'dead-model',
          provider: 'llama.cpp',
          gguf_path: path.join(dir, 'missing.gguf'),
        },
      ],
      active_model: 'gemma-local',
      groups: {
        'llamacpp-gemma': {
          spawn: { num_ctx: 32768 },
          sampling: { top_k: 64, stop: '<end_of_turn>' },
        },
      },
      llama_server: { binary: '/usr/bin/llama-server' },
      ...overrides,
    };
  }

  it('assembles size, quant/family, active/loaded, and dead-entry flags', async () => {
    const state = await buildModelManagerState(baseConfig(), configPath, (name) => name === 'gemma-local');

    const live = state.models.find((m) => m.name === 'gemma-local')!;
    expect(live.sizeBytes).toBe(1024 + 256);
    expect(live.fileMissing).toBe(false);
    expect(live.isActive).toBe(true);
    expect(live.isLoaded).toBe(true);
    // group-inherited sampling isn't on the raw entry itself.
    expect(live.overrideKeys).not.toContain('sampling');
    expect(live.resolved.sampling?.top_k).toBe(64);

    const dead = state.models.find((m) => m.name === 'dead-model')!;
    expect(dead.fileMissing).toBe(true);
    expect(dead.isActive).toBe(false);
    expect(dead.isLoaded).toBe(false);
  });

  it('reports groups and total disk footprint', async () => {
    const state = await buildModelManagerState(baseConfig(), configPath, () => false);
    expect(state.groups['llamacpp-gemma']).toBeDefined();
    expect(state.totalDiskBytes).toBeGreaterThanOrEqual(1024 + 256);
    expect(state.activeModel).toBe('gemma-local');
  });

  it('detects orphan GGUFs under model_dirs not referenced by any entry', async () => {
    const orphanPath = path.join(dir, 'orphan.gguf');
    fs.writeFileSync(orphanPath, Buffer.alloc(512, 1));
    const state = await buildModelManagerState(
      baseConfig({ model_dirs: [dir] }),
      configPath,
      () => false,
    );
    const orphan = state.orphans.find((o) => path.resolve(o.path) === path.resolve(orphanPath));
    expect(orphan).toBeDefined();
    expect(orphan?.sizeBytes).toBe(512);
    // configured models must never show up as orphans
    expect(state.orphans.some((o) => path.resolve(o.path) === path.resolve(ggufPath))).toBe(false);
  });

  it('skips orphan scanning entirely when model_dirs is unset', async () => {
    const state = await buildModelManagerState(baseConfig(), configPath, () => false);
    expect(state.orphans).toEqual([]);
  });
});
