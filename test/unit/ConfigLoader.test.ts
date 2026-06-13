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

  it('parses the F6 shape: defaults, profiles, spawn, aliases, mmproj_path', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: gemma@main
llama_server:
  binary: llama-server
defaults:
  system_prompt: shared
  sampling: { temperature: 0.6 }
profiles:
  main: { think: true, reasoning_effort: medium }
  worker: { think: false, sampling: { stop: "<end_of_turn>" } }
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
    mmproj_path: C:/models/gemma-mmproj.gguf
    spawn:
      num_ctx: 32768
      n_parallel: 4
      type_k: q8_0
    spawn_profiles:
      long-context: { num_ctx: 131072 }
aliases:
  gemma-worker: gemma@worker
`, 'utf8');

    const config = loadConfig(dir);
    expect(config.defaults?.system_prompt).toBe('shared');
    expect(Object.keys(config.profiles ?? {}).sort()).toEqual(['main', 'worker']);
    const gemma = config.models.find((m) => m.name === 'gemma');
    expect(gemma?.mmproj_path).toBe('C:/models/gemma-mmproj.gguf'); // survives parse
    expect(gemma?.spawn?.num_ctx).toBe(32768);
    expect(gemma?.spawn_profiles?.['long-context']?.num_ctx).toBe(131072);
    expect(config.aliases?.['gemma-worker']).toBe('gemma@worker');
  });

  it('accepts active_model carrying an @profile', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: gemma@main
llama_server:
  binary: llama-server
profiles:
  main: { think: true }
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
`, 'utf8');
    const config = loadConfig(dir);
    expect(config.active_model).toBe('gemma@main');
  });

  it('rejects active_model with an unknown @profile', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: gemma@nope
llama_server:
  binary: llama-server
profiles:
  main: { think: true }
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
`, 'utf8');
    expect(() => loadConfig(dir)).toThrow(/unknown profile "nope"/i);
  });

  it('rejects an alias targeting an unknown model', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: gemma
llama_server:
  binary: llama-server
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
aliases:
  old: missing@main
`, 'utf8');
    expect(() => loadConfig(dir)).toThrow(/targets unknown model "missing"/i);
  });

  it('accepts active_model that is an alias key', () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), `active_model: old-name
llama_server:
  binary: llama-server
profiles:
  worker: { think: false }
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
aliases:
  old-name: gemma@worker
`, 'utf8');
    const config = loadConfig(dir);
    expect(config.active_model).toBe('old-name');
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
