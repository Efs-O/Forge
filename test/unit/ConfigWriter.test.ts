import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfigSafely } from '../../src/config/ConfigWriter';
import { loadConfig } from '../../src/config/ConfigLoader';

describe('writeConfigSafely', () => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-writer-'));
    configPath = path.join(directory, 'config.yaml');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('validates and writes a loadable config', () => {
    writeConfigSafely(configPath, {
      models: [{ name: 'ollama-model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      active_model: 'ollama-model',
      llama_server: {},
    });
    expect(loadConfig(directory).active_model).toBe('ollama-model');
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
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
