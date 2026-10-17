import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfigSafely } from '../../src/config/ConfigWriter';
import { loadConfig } from '../../src/config/ConfigLoader';

vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(),
}));

const tempFiles = (directory: string): string[] =>
  fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));

const ollamaConfig = {
  models: [{ name: 'm', provider: 'ollama' as const, endpoint: 'http://127.0.0.1:11434' }],
  active_model: 'm',
  llama_server: {},
};

describe('writeConfigSafely', () => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-writer-'));
    configPath = path.join(directory, 'config.yaml');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('preserves the live config when replacement fails', () => {
    fs.writeFileSync(configPath, 'original: true\n');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('replacement denied');
    });
    expect(() => writeConfigSafely(configPath, {
      models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      active_model: 'm', llama_server: {},
    })).toThrow('replacement denied');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('original: true\n');
    expect(tempFiles(directory)).toEqual([]);
  });

  it('leaves the live config and no temp file when the flush fails', () => {
    fs.writeFileSync(configPath, 'original: true\n');
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('flush failed');
    });
    expect(() => writeConfigSafely(configPath, ollamaConfig)).toThrow('flush failed');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('original: true\n');
    expect(tempFiles(directory)).toEqual([]);
  });

  it('creates a missing config folder before taking the lock (first-run wizard)', () => {
    const nested = path.join(directory, 'workspace', '.forge', 'config.yaml');
    writeConfigSafely(nested, ollamaConfig);
    expect(loadConfig(path.dirname(nested)).active_model).toBe('m');
    expect(fs.existsSync(`${nested}.lock`)).toBe(false);
  });

  it('validates and writes a loadable config', () => {
    writeConfigSafely(configPath, {
      models: [{ name: 'ollama-model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      active_model: 'ollama-model',
      llama_server: {},
    });
    expect(loadConfig(directory).active_model).toBe('ollama-model');
    expect(tempFiles(directory)).toEqual([]);
  });

  it('backs up the previous file before replacing it', () => {
    fs.writeFileSync(configPath, 'original: true\n');
    writeConfigSafely(configPath, {
      models: [{ name: 'ollama-model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      active_model: 'ollama-model',
      llama_server: {},
    });
    expect(fs.readFileSync(`${configPath}.bak`, 'utf8')).toBe('original: true\n');
  });

  it('rejects invalid configs before touching the existing file', () => {
    fs.writeFileSync(configPath, 'original: true\n');
    expect(() => writeConfigSafely(configPath, {
      models: [], active_model: null, llama_server: {},
    })).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe('original: true\n');
  });
});
