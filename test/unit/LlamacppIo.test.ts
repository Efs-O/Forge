import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeSetBinary, sha256File } from '../../src/jobs/actions/llamacppIo';

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
});
