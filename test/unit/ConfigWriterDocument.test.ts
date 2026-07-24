import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addModel,
  removeModel,
  setModelField,
  setTopLevel,
  updateConfigFile,
  writeConfigSafely,
} from '../../src/config/ConfigWriter';
import { loadConfig } from '../../src/config/ConfigLoader';

const FIXTURE = `# Forge config — hand-authored comments must survive edits.
active_model: gemma-a
llama_server:
  binary: /path/to/llama-server

models:
  # gemma-a: primary coding driver
  - name: gemma-a
    gguf_path: /models/gemma-a.gguf
    spawn: { n_batch: 512, flash_attn: true }
    sampling: { top_k: 64 }

  # gemma-b: headless worker twin
  - name: gemma-b
    gguf_path: /models/gemma-b.gguf
    spawn: { n_batch: 512, flash_attn: true }
    sampling: { top_k: 64 }
`;

describe('updateConfigFile (comment-preserving Document API)', () => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-doc-'));
    configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, FIXTURE, 'utf8');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('preserves comments and key order for an unrelated top-level edit', () => {
    updateConfigFile(configPath, (doc) => {
      setTopLevel(doc, 'active_model', 'gemma-b');
    });
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('# Forge config — hand-authored comments must survive edits.');
    expect(raw).toContain('# gemma-a: primary coding driver');
    expect(raw).toContain('# gemma-b: headless worker twin');
    expect(raw).toContain('active_model: gemma-b');
    expect(loadConfig(directory).active_model).toBe('gemma-b');
  });

  it('preserves an untouched model entry comment while editing a sibling field', () => {
    updateConfigFile(configPath, (doc) => {
      setModelField(doc, 'gemma-a', 'group', 'gemma-board');
    });
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('# gemma-a: primary coding driver');
    expect(raw).toContain('# gemma-b: headless worker twin');
    expect(raw).toContain('group: gemma-board');
  });

  it('adds and removes model entries via the typed helpers', () => {
    updateConfigFile(configPath, (doc) => {
      addModel(doc, { name: 'gemma-c', gguf_path: '/models/gemma-c.gguf' });
      removeModel(doc, 'gemma-b');
    });
    const config = loadConfig(directory);
    expect(config.models.map((m) => m.name).sort()).toEqual(['gemma-a', 'gemma-c']);
  });

  it('throws on a corrupted existing file and writes nothing', () => {
    fs.writeFileSync(configPath, 'models: [\n  - broken: [unterminated\n', 'utf8');
    expect(() =>
      updateConfigFile(configPath, (doc) => {
        setTopLevel(doc, 'active_model', 'x');
      }),
    ).toThrow(/parse failed/);
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('throws and writes nothing when a mutation produces an invalid config', () => {
    const before = fs.readFileSync(configPath, 'utf8');
    expect(() =>
      updateConfigFile(configPath, (doc) => {
        setModelField(doc, 'gemma-a', 'num_ctx', 'not-a-number');
      }),
    ).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
  });
});

describe('atomic write failure path', () => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-atomic-'));
    configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, FIXTURE, 'utf8');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('leaves the original file untouched when the temp-file write step fails', () => {
    const before = fs.readFileSync(configPath, 'utf8');
    // Force the write step to fail by occupying the `.tmp` path with a
    // directory — writeFileSync(temporaryPath, …) throws EISDIR before
    // anything ever touches the real config file.
    fs.mkdirSync(`${configPath}.tmp`);

    expect(() =>
      updateConfigFile(configPath, (doc) => {
        setTopLevel(doc, 'active_model', 'gemma-b');
      }),
    ).toThrow();

    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });
});

describe('writeConfigSafely reconciliation (legacy whole-object call shape)', () => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-reconcile-'));
    configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, FIXTURE, 'utf8');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('preserves per-model comments for entries whose fields did not change', () => {
    const config = loadConfig(directory);
    config.active_model = 'gemma-b';
    writeConfigSafely(configPath, config);

    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('# gemma-a: primary coding driver');
    expect(raw).toContain('# gemma-b: headless worker twin');
    expect(loadConfig(directory).active_model).toBe('gemma-b');
  });
});
