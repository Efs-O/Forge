import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeSetBinary, sha256File } from '../../src/jobs/actions/llamacppIo';
import { loadConfig } from '../../src/config/ConfigLoader';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe('llamacpp IO security and persistence', () => {
  it('computes a streamed SHA-256 digest for a downloaded file', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'forge-llamacpp-io-'));
    const filePath = join(tempRoot, 'download.zip');
    writeFileSync(filePath, 'abc');

    await expect(sha256File(filePath)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('updates and removes only llama_server.binary in config.yaml', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'forge-llamacpp-config-'));
    const configPath = join(tempRoot, 'config.yaml');
    writeFileSync(
      configPath,
      '# keep this comment\nllama_server:\n  binary: old.exe\n  host: 127.0.0.1\nmodels:\n  - name: test-model\n    provider: ollama\n    endpoint: http://127.0.0.1:11434\n',
    );
    const setBinary = makeSetBinary(configPath);

    setBinary('new.exe');

    let contents = readFileSync(configPath, 'utf8');
    expect(contents).toContain('# keep this comment');
    expect(parse(contents)).toEqual({
      llama_server: { binary: 'new.exe', host: '127.0.0.1' },
      models: [{ name: 'test-model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    });

    setBinary(undefined);
    contents = readFileSync(configPath, 'utf8');
    expect(parse(contents)).toEqual({
      llama_server: { host: '127.0.0.1' },
      models: [{ name: 'test-model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    });
  });

  /**
   * The 2026-10-27 08:04 `llama-updates` run: download, digest, extract and
   * smoke test all passed, then the binary switch was refused because
   * `cloud_relay.models` still named a model that had been deleted. A stale
   * reference now loads and writes like any other, so the switch reaches the
   * file and the comment above the hand-maintained list survives it.
   */
  it('switches the binary on a config that still names a removed model', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'forge-llamacpp-stale-ref-'));
    const configPath = join(tempRoot, 'config.yaml');
    writeFileSync(
      configPath,
      [
        '# the laptop cloud list, hand-maintained',
        'llama_server:',
        '  binary: old.exe',
        'models:',
        '  - name: keep',
        '    provider: llama.cpp',
        '    gguf_path: /models/keep.gguf',
        'active_model: keep',
        'cloud_relay:',
        '  enabled: true',
        '  port: 8797',
        '  max_body_mb: 32',
        '  models:',
        '    - gone-model',
        '',
      ].join('\n'),
    );

    makeSetBinary(configPath)('new.exe');

    const contents = readFileSync(configPath, 'utf8');
    expect(contents).toContain('# the laptop cloud list');
    expect(parse(contents)).toMatchObject({
      llama_server: { binary: 'new.exe' },
      cloud_relay: { models: ['gone-model'] },
    });
    expect(loadConfig(tempRoot).llama_server.binary).toBe('new.exe');
  });
});
