import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addModel,
  removeModel,
  setModelField,
  setNestedField,
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

describe('setNestedField', () => {
  // The helper mutates a live `yaml` Document node graph; the schema
  // validation that guards `updateConfigFile` is covered by the tests above,
  // so these exercise the node-graph behaviour in isolation.
  const VOICE_YAML = [
    'active_model: gemma',
    'voice:',
    '  enabled: true',
    '  # the whisper paths must point at a real install',
    '  whisper_binary: N:/AI/whisper-cli.exe',
    '  output:',
    '    enabled: true',
    '    piper_binary: N:/AI/piper.exe',
    '    max_chars: 1200',
    '',
  ].join('\n');

  const parse = (s: string): YAML.Document => YAML.parseDocument(s);

  it('sets a field on an existing nested block and preserves siblings', () => {
    const doc = parse(VOICE_YAML);
    setNestedField(doc, ['voice', 'output', 'enabled'], false);

    const js = doc.toJS() as Record<string, any>;
    expect(js.voice.output.enabled).toBe(false);
    // Sibling keys on the same block survive.
    expect(js.voice.output.piper_binary).toBe('N:/AI/piper.exe');
    expect(js.voice.output.max_chars).toBe(1200);
    // The rest of the voice block is untouched.
    expect(js.voice.enabled).toBe(true);
    expect(js.voice.whisper_binary).toBe('N:/AI/whisper-cli.exe');
  });

  it('preserves a hand-written comment on an untouched key', () => {
    const doc = parse(VOICE_YAML);
    setNestedField(doc, ['voice', 'output', 'enabled'], false);

    const raw = doc.toString({ lineWidth: 0 });
    expect(raw).toContain('# the whisper paths must point at a real install');
  });

  it('lazily creates intermediate maps when the block does not exist', () => {
    // `voice` exists but `voice.input` does not — the helper must create it.
    const doc = parse(VOICE_YAML);
    setNestedField(doc, ['voice', 'input', 'max_seconds'], 90);

    const js = doc.toJS() as Record<string, any>;
    expect(js.voice.input.max_seconds).toBe(90);
    // The pre-existing output block is untouched by creating a sibling block.
    expect(js.voice.output.enabled).toBe(true);
    expect(js.voice.output.piper_binary).toBe('N:/AI/piper.exe');
  });

  it('creates the whole chain from a top-level key that is absent', () => {
    const doc = parse(VOICE_YAML);
    setNestedField(doc, ['search', 'provider'], 'tavily');

    const js = doc.toJS() as Record<string, any>;
    expect(js.search.provider).toBe('tavily');
    // The voice block, untouched, is still there.
    expect(js.voice.output.enabled).toBe(true);
  });

  it('deletes the field when value is undefined', () => {
    const doc = parse(VOICE_YAML);
    setNestedField(doc, ['voice', 'output', 'max_chars'], undefined);

    const js = doc.toJS() as Record<string, any>;
    expect(js.voice.output.max_chars).toBeUndefined();
    expect(js.voice.output.enabled).toBe(true);
  });

  it('works on a document whose root is empty', () => {
    const doc = parse('');
    setNestedField(doc, ['voice', 'output', 'enabled'], true);

    const js = doc.toJS() as Record<string, any>;
    expect(js.voice.output.enabled).toBe(true);
  });
});
