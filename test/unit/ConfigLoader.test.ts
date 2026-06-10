import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolveExplicitConfigPath } from '../../src/config/ConfigLoader';

vi.mock('vscode', () => ({
  workspace: {},
}));

const tempDirs: string[] = [];

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-'));
  tempDirs.push(dir);
  return dir;
}

describe('loadConfig', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sorts models alphabetically', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: z-cloud
llama_server:
  binary: llama-server
models:
  - name: z-cloud
    provider: ollama
    endpoint: http://127.0.0.1:11434
  - name: alpha-cloud
    provider: ollama
    endpoint: http://127.0.0.1:11434
  - name: local-gguf
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
`, 'utf8');

    const config = loadConfig(dir);
    expect(config.models.map((model) => model.name)).toEqual([
      'alpha-cloud',
      'local-gguf',
      'z-cloud',
    ]);
    expect(config.active_model).toBe('z-cloud');
  });

  it('rejects duplicate model names in config.yaml', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: duplicate
llama_server:
  binary: llama-server
models:
  - name: duplicate
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
  - name: duplicate
    provider: ollama
    endpoint: http://127.0.0.1:11434
`, 'utf8');

    expect(() => loadConfig(dir)).toThrow(/duplicate model name/i);
  });

  it('allows no active model when config uses active_model: none', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: none
llama_server:
  binary: llama-server
models:
  - name: local-gguf
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
`, 'utf8');

    const config = loadConfig(dir);
    expect(config.active_model).toBeNull();
    expect(config.models.map((model) => model.name)).toEqual(['local-gguf']);
  });

  it('loads optional embeddings config when enabled', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: local-gguf
llama_server:
  binary: llama-server
models:
  - name: local-gguf
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
embeddings:
  enabled: true
  model_path: C:/models/embedding.gguf
  port: 8091
  auto_index_on_search: true
  max_file_size_kb: 128
`, 'utf8');

    const config = loadConfig(dir);
    expect(config.embeddings).toMatchObject({
      enabled: true,
      model_path: 'C:/models/embedding.gguf',
      port: 8091,
      auto_index_on_search: true,
      max_file_size_kb: 128,
    });
  });

  it('loads openai-compatible cloud models from config.yaml', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: codex
models:
  - name: codex
    provider: openai
    api_key_secret: openai
  - name: claude-via-gateway
    provider: openai-compatible
    endpoint: https://gateway.example.com
    api_key_secret: gateway
`, 'utf8');

    const config = loadConfig(dir);
    expect(config.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'codex', provider: 'openai', api_key_secret: 'openai' }),
        expect.objectContaining({
          name: 'claude-via-gateway',
          provider: 'openai-compatible',
          endpoint: 'https://gateway.example.com',
          api_key_secret: 'gateway',
        }),
      ]),
    );
  });

  it('rejects openai-compatible models without endpoint', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: bad
models:
  - name: bad
    provider: openai-compatible
    api_key_secret: gateway
`, 'utf8');

    expect(() => loadConfig(dir)).toThrow(/endpoint is required for provider: openai-compatible/i);
  });
});

describe('resolveExplicitConfigPath', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts absolute path to config.yaml file', () => {
    const dir = mkTempDir();
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, 'active_model: a\nmodels:\n  - name: a\n', 'utf8');
    expect(resolveExplicitConfigPath(configPath)).toBe(configPath);
  });

  it('accepts absolute path to directory containing config.yaml', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'active_model: a\nmodels:\n  - name: a\n', 'utf8');
    expect(resolveExplicitConfigPath(dir)).toBe(path.join(dir, 'config.yaml'));
  });

  it('returns null for wrong filename or missing path', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'other.yaml'), 'x: 1\n', 'utf8');
    expect(resolveExplicitConfigPath(path.join(dir, 'other.yaml'))).toBeNull();
    expect(resolveExplicitConfigPath(path.join(dir, 'nope'))).toBeNull();
    expect(resolveExplicitConfigPath('')).toBeNull();
  });
});
