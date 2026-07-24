import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushModelUsageForTest,
  readForgeState,
  recordModelUsage,
} from '../../src/sidebar/modelManager/usageTracker';

describe('usageTracker', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mm-usage-'));
    configPath = path.join(dir, 'config.yaml');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads empty state when state.json does not exist yet', () => {
    expect(readForgeState(configPath)).toEqual({ last_used: {} });
  });

  it('writes state.json alongside config.yaml, never inside it', () => {
    recordModelUsage(configPath, 'my-model');
    flushModelUsageForTest(configPath, 'my-model');

    const statePath = path.join(dir, 'state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(typeof written.last_used['my-model']).toBe('string');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('preserves other models already recorded', () => {
    recordModelUsage(configPath, 'model-a');
    flushModelUsageForTest(configPath, 'model-a');
    recordModelUsage(configPath, 'model-b');
    flushModelUsageForTest(configPath, 'model-b');

    const state = readForgeState(configPath);
    expect(Object.keys(state.last_used).sort()).toEqual(['model-a', 'model-b']);
  });

  it('never throws even when the .forge directory cannot be created', () => {
    const badConfigPath = path.join(dir, 'a.gguf', 'nested', 'config.yaml');
    fs.writeFileSync(path.join(dir, 'a.gguf'), 'not a directory');
    expect(() => {
      recordModelUsage(badConfigPath, 'my-model');
      flushModelUsageForTest(badConfigPath, 'my-model');
    }).not.toThrow();
  });
});
