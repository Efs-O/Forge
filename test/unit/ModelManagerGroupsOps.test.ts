import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addGroup, removeGroup, setGroupField } from '../../src/sidebar/modelManager/groupsOps';
import { writeConfigSafely } from '../../src/config/ConfigWriter';
import { loadConfig } from '../../src/config/ConfigLoader';
import type { ForgeConfig } from '../../src/config/types';

describe('modelManager groupsOps', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mm-groupsops-'));
    configPath = path.join(dir, 'config.yaml');
    writeConfigSafely(configPath, {
      models: [{ name: 'm1', provider: 'llama.cpp', gguf_path: path.join(dir, 'a.gguf') }],
      active_model: 'm1',
      llama_server: { binary: '/bin/llama-server' },
    } as ForgeConfig);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('adds a new empty group, idempotently', () => {
    addGroup(configPath, 'workers');
    addGroup(configPath, 'workers');
    expect(loadConfig(dir).groups?.['workers']).toEqual({});
  });

  it('sets and deletes a field on an existing group', () => {
    addGroup(configPath, 'workers');
    setGroupField(configPath, 'workers', 'num_ctx', 65536);
    expect(loadConfig(dir).groups?.['workers']?.num_ctx).toBe(65536);
    setGroupField(configPath, 'workers', 'num_ctx', undefined);
    expect(loadConfig(dir).groups?.['workers']?.num_ctx).toBeUndefined();
  });

  it('throws when setting a field on a group that does not exist', () => {
    expect(() => setGroupField(configPath, 'missing', 'num_ctx', 1)).toThrow(/not found/);
  });

  it('removes a group', () => {
    addGroup(configPath, 'temp');
    removeGroup(configPath, 'temp');
    expect(loadConfig(dir).groups?.['temp']).toBeUndefined();
  });
});
