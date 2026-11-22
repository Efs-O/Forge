import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfigSafely } from '../../src/config/ConfigWriter';
import { setNestedField, setTopLevel, updateConfigFile } from '../../src/config/ConfigWriter';
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

/**
 * A whole-object write is handed the keys one config happens to hold. `policy.yaml`
 * is owner-authored and holds far more than that (`approvals`, `engines`,
 * `mcp_servers`, `remote`), and `x_shared` can never be in the object at all
 * because zod strips it — so neither may be treated as stale (BL-048, BL-049).
 */
const CONFIG_WITH_MODEL =
  'active_model: m\nmodels:\n  - name: m\n    provider: ollama\n    endpoint: http://127.0.0.1:11434\n';

describe('writeConfigSafely against a policy.yaml it was not told about (BL-048, BL-049)', () => {
  let directory: string;
  let configPath: string;
  let policyPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-writer-policy-'));
    configPath = path.join(directory, 'config.yaml');
    policyPath = path.join(directory, 'policy.yaml');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps every policy block the written config never mentions', () => {
    fs.writeFileSync(
      policyPath,
      [
        'permissions:',
        '  net:',
        '    search: true',
        'approvals:',
        '  always: []',
        'engines:',
        '  llama:',
        '    llama_server_binary: C:/llama/llama-server.exe',
        'mcp_servers:',
        '  - name: halluscribe',
        '    command: node',
        '    args: [server.js]',
        'remote:',
        '  enabled: true',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(configPath, CONFIG_WITH_MODEL);
    writeConfigSafely(
      configPath,
      { ...ollamaConfig, permissions: { net: { search: false } } },
      { policyPath },
    );
    const after = fs.readFileSync(policyPath, 'utf8');
    for (const block of ['approvals:', 'engines:', 'mcp_servers:', 'remote:']) {
      expect(after).toContain(block);
    }
    // A block the object DID give is still updated, not left stale.
    expect(after).toContain('search: false');
  });

  it('never overwrites an owner policy block with a schema default the caller never named', () => {
    fs.writeFileSync(
      policyPath,
      [
        'permissions:',
        '  net:',
        '    search: true',
        'agent_links:',
        '  telegram:',
        '    workspace: N:/other project',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(configPath, CONFIG_WITH_MODEL);
    // The object never mentions `agent_links`, but ForgeConfigSchema.parse fills
    // one in, and that default used to replace whatever the owner had written.
    writeConfigSafely(
      configPath,
      { ...ollamaConfig, permissions: { net: { search: false } } },
      { policyPath },
    );
    const after = fs.readFileSync(policyPath, 'utf8');
    expect(after).toContain('workspace: N:/other project');
    expect(after).toContain('search: false');
  });

  it('keeps x_shared and the aliases that still reference it (BL-049)', () => {
    fs.writeFileSync(
      policyPath,
      [
        'x_shared:',
        '  mcp_args: &mcp_args [server.js]',
        'mcp_servers:',
        '  - name: halluscribe',
        '    command: node',
        '    args: *mcp_args',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      configPath,
      'x_shared:\n  hint: &hint "keep me"\n' + CONFIG_WITH_MODEL,
    );
    // Before the fix this throws: deleting x_shared leaves `*mcp_args`
    // unresolvable, and `doc.toString()` refuses to serialise the document.
    // `permissions` is passed so the policy write runs whatever else the caller
    // omitted — without a policy key in hand there would be nothing to reconcile.
    expect(() =>
      writeConfigSafely(
        configPath,
        { ...ollamaConfig, permissions: { net: { search: false } } },
        { policyPath },
      ),
    ).not.toThrow();
    expect(fs.readFileSync(policyPath, 'utf8')).toContain('*mcp_args');
    expect(fs.readFileSync(policyPath, 'utf8')).toContain('x_shared:');
    expect(fs.readFileSync(configPath, 'utf8')).toContain('x_shared:');
  });
});

/**
 * The two halves of the writer rule, taken from the 2026-10-27 `llama-updates`
 * failure: a stale model reference must NOT block an unrelated write (the
 * llama.cpp binary switch was refused because of a name that had been stale for
 * weeks), but a write that CREATES one must be refused, because that is how the
 * stale name got there in the first place.
 */
describe('model references and the write path', () => {
  let directory: string;
  let configPath: string;

  const VALID_HEAD = `llama_server:
  binary: /bin/llama-server
models:
  - name: keep
    provider: llama.cpp
    gguf_path: /models/keep.gguf
  - name: keep-cloud
    provider: openrouter
    api_key_secret: test.ref
active_model: keep
`;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-writer-refs-'));
    configPath = path.join(directory, 'config.yaml');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function seed(body: string): void {
    fs.writeFileSync(configPath, `${VALID_HEAD}${body}`, 'utf8');
  }

  it('refuses a write that creates a new leftover and names the path', () => {
    seed('');
    expect(() =>
      updateConfigFile(configPath, (doc) => {
        setTopLevel(doc, 'jobs', { enabled: true, default_model: 'gone-jobs-model' });
      }),
    ).toThrow(/jobs\.default_model.*gone-jobs-model/s);
    // Nothing was written: the refusal happens before the atomic write.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(`${VALID_HEAD}`);
    expect(loadConfig(directory).jobs).toBeUndefined();
  });
  it('writes normally while a stale reference is already in the file', () => {
    seed(`cloud_relay:
  enabled: true
  port: 8797
  max_body_mb: 32
  models:
    - gone-model
`);
    // The stale name is tolerated on write exactly as it is on load, so the
    // llama.cpp switch and every other config edit still work.
    updateConfigFile(configPath, (doc) => {
      setNestedField(doc, ['llama_server', 'binary'], '/bin/llama-server-new');
    });
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('gone-model');
    expect(raw).toContain('/bin/llama-server-new');
    const config = loadConfig(directory);
    expect(config.llama_server.binary).toBe('/bin/llama-server-new');
    expect(config.cloud_relay?.models).toEqual(['gone-model']);
  });

  /** Re-pointing an alias at a different removed model creates a NEW leftover
   *  (path plus value is its identity), so it is refused like any other. */
  it('refuses re-pointing an alias at another removed model', () => {
    seed(`aliases:
  old: gone-model-1
`);
    expect(() =>
      updateConfigFile(configPath, (doc) => {
        setTopLevel(doc, 'aliases', { old: 'gone-model-2' });
      }),
    ).toThrow(/aliases\.old.*gone-model-2/s);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('gone-model-1');
  });

  it('refuses a write that would leave two models sharing a short_name', () => {
    seed('');
    expect(() =>
      updateConfigFile(configPath, (doc) => {
        setTopLevel(doc, 'models', [
          { name: 'keep', provider: 'llama.cpp', gguf_path: '/models/keep.gguf', short_name: 'k' },
          {
            name: 'keep-cloud',
            provider: 'openrouter',
            api_key_secret: 'test.ref',
            short_name: 'k',
          },
        ]);
      }),
    ).toThrow(/short_name "k" is used by both/s);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(VALID_HEAD);
  });
});
