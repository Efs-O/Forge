import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolveExplicitConfigPath } from '../../src/config/ConfigLoader';

const showWarningMessage = vi.fn();

vi.mock('vscode', () => ({
  workspace: {},
  window: {
    showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
  },
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
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: z-cloud
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
`,
      'utf8',
    );

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
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: duplicate
llama_server:
  binary: llama-server
models:
  - name: duplicate
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
  - name: duplicate
    provider: ollama
    endpoint: http://127.0.0.1:11434
`,
      'utf8',
    );

    expect(() => loadConfig(dir)).toThrow(/duplicate model name/i);
  });

  it('allows no active model when config uses active_model: none', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: none
llama_server:
  binary: llama-server
models:
  - name: local-gguf
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
`,
      'utf8',
    );

    const config = loadConfig(dir);
    expect(config.active_model).toBeNull();
    expect(config.models.map((model) => model.name)).toEqual(['local-gguf']);
  });

  it('loads optional embeddings config when enabled', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: local-gguf
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
`,
      'utf8',
    );

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
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: codex
models:
  - name: codex
    provider: openai
    api_key_secret: openai
  - name: claude-via-gateway
    provider: openai-compatible
    endpoint: https://gateway.example.com
    api_key_secret: gateway
`,
      'utf8',
    );

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
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: bad
models:
  - name: bad
    provider: openai-compatible
    api_key_secret: gateway
`,
      'utf8',
    );

    expect(() => loadConfig(dir)).toThrow(/endpoint is required for provider: openai-compatible/i);
  });

  it('parses the F6 shape: defaults, profiles, spawn, aliases, mmproj_path', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma@main
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
`,
      'utf8',
    );

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
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma@main
llama_server:
  binary: llama-server
profiles:
  main: { think: true }
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
`,
      'utf8',
    );
    const config = loadConfig(dir);
    expect(config.active_model).toBe('gemma@main');
  });

  it('rejects active_model with an unknown @profile', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma@nope
llama_server:
  binary: llama-server
profiles:
  main: { think: true }
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
`,
      'utf8',
    );
    expect(() => loadConfig(dir)).toThrow(/unknown profile "nope"/i);
  });

  it('rejects an alias targeting an unknown model', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma
llama_server:
  binary: llama-server
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
aliases:
  old: missing@main
`,
      'utf8',
    );
    expect(() => loadConfig(dir)).toThrow(/targets unknown model "missing"/i);
  });

  it('accepts a groups-based config and validates group references (F7)', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma
llama_server:
  binary: llama-server
groups:
  llamacpp-gemma:
    spawn: { n_batch: 512 }
    num_ctx: 32768
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
    group: llamacpp-gemma
`,
      'utf8',
    );
    const config = loadConfig(dir);
    expect(Object.keys(config.groups ?? {})).toEqual(['llamacpp-gemma']);
    expect(config.models[0]?.group).toBe('llamacpp-gemma');
  });

  it('rejects a model referencing an unknown group', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma
llama_server:
  binary: llama-server
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
    group: missing-group
`,
      'utf8',
    );
    expect(() => loadConfig(dir)).toThrow(/references unknown group "missing-group"/i);
  });

  it('rejects a model referencing an unknown group via the groups array', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma
llama_server:
  binary: llama-server
groups:
  ok: { think: false }
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
    groups: [ok, nope]
`,
      'utf8',
    );
    expect(() => loadConfig(dir)).toThrow(/references unknown group "nope"/i);
  });

  it('rejects a short_name colliding with another configured model name', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma
llama_server:
  binary: llama-server
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
    short_name: qwen
  - name: qwen
    provider: llama.cpp
    gguf_path: C:/models/qwen.gguf
`,
      'utf8',
    );
    expect(() => loadConfig(dir)).toThrow(/short_name "qwen".*collides with a configured model name/i);
  });

  it('rejects a short_name colliding with an alias key', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma
llama_server:
  binary: llama-server
models:
  - name: gemma
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
    short_name: worker
aliases:
  worker: gemma
`,
      'utf8',
    );
    expect(() => loadConfig(dir)).toThrow(/short_name "worker".*collides with alias/i);
  });

  it('rejects two models sharing the same short_name', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma-a
llama_server:
  binary: llama-server
models:
  - name: gemma-a
    provider: llama.cpp
    gguf_path: C:/models/a.gguf
    short_name: gemma4
  - name: gemma-b
    provider: llama.cpp
    gguf_path: C:/models/b.gguf
    short_name: gemma4
`,
      'utf8',
    );
    expect(() => loadConfig(dir)).toThrow(
      /short_name "gemma4" is used by both "gemma-a" and "gemma-b"/i,
    );
  });

  it('accepts a unique short_name', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: gemma-26b-a4b-it-iq3s
llama_server:
  binary: llama-server
models:
  - name: gemma-26b-a4b-it-iq3s
    provider: llama.cpp
    gguf_path: C:/models/gemma.gguf
    short_name: gemma4
`,
      'utf8',
    );
    const config = loadConfig(dir);
    expect(config.models[0]?.short_name).toBe('gemma4');
  });

  /**
   * `permissions.agents.cloud_workers` was a valid key before worker dispatch
   * was removed. Anyone who set it must still be able to start Forge after
   * upgrading — a config that no longer boots is the worst possible upgrade.
   */
  it('still boots a config carrying the deprecated cloud_workers key', () => {
    showWarningMessage.mockClear();
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: local-gguf
llama_server:
  binary: llama-server
permissions:
  agents:
    delegate: true
    cloud_workers: true
models:
  - name: local-gguf
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
`,
      'utf8',
    );

    const config = loadConfig(dir);
    expect(config.active_model).toBe('local-gguf');
    expect(config.permissions?.agents?.delegate).toBe(true);
    // This fixture also trips the suppressed-permissions warning: naming only
    // `agents` makes the schema defaults authoritative for every other group.
    const warnings = showWarningMessage.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((text) => text.includes('cloud_workers'))).toBe(true);
  });

  /**
   * Adding one permissions group makes the schema defaults authoritative for
   * every other group, so capabilities go dark without ever being switched off.
   * The only symptom is a tool missing from the model's list — which reads as a
   * broken model rather than as config, and cost real turns twice.
   */
  it('warns which capabilities a partial permissions block switched off', () => {
    showWarningMessage.mockClear();
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: local-gguf
llama_server:
  binary: llama-server
permissions:
  fs:
    delete: true
  exec:
    headless: true
    terminal: true
  git:
    write: true
models:
  - name: local-gguf
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
`,
      'utf8',
    );

    loadConfig(dir);
    const warnings = showWarningMessage.mock.calls.map((call) => String(call[0]));
    const suppressed = warnings.find((text) => text.includes('OFF by schema default'));
    expect(suppressed).toBeDefined();
    expect(suppressed).toContain('net.search');
    expect(suppressed).toContain('net.fetch');
    expect(suppressed).not.toContain('git.write');
  });

  it('says nothing when the deprecated key is absent', () => {
    showWarningMessage.mockClear();
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: local-gguf
llama_server:
  binary: llama-server
models:
  - name: local-gguf
    provider: llama.cpp
    gguf_path: C:/models/local.gguf
`,
      'utf8',
    );

    loadConfig(dir);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('accepts active_model that is an alias key', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `active_model: old-name
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
`,
      'utf8',
    );
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
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      'active_model: a\nmodels:\n  - name: a\n',
      'utf8',
    );
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
