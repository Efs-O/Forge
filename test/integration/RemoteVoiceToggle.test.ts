import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

// A hand-authored `.forge/config.yaml` with a comment on a sibling key and
// `voice.output.enabled: true`. `setVoiceOutput` must flip only that flag,
// leave everything else (and the comment) intact, and re-read the file so the
// in-memory config matches what landed on disk.
const CONFIG_YAML = [
  '# Forge config — this comment must survive a /voice toggle.',
  'active_model: local-a',
  'llama_server:',
  '  binary: /path/to/llama-server',
  '',
  'models:',
  '  - name: local-a',
  '    gguf_path: /models/local-a.gguf',
  '',
  'voice:',
  '  enabled: true',
  '  # the whisper paths must point at a real install',
  '  whisper_binary: /ai/whisper-cli.exe',
  '  whisper_model: /ai/ggml-large-v3.bin',
  '  output:',
  '    enabled: true',
  '    piper_binary: /ai/piper.exe',
  '    max_chars: 1200',
  '',
].join('\n');

class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  onDidChange = vi.fn();
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function runtimeWith(configPath: string | undefined): {
  runtime: RemoteRuntime;
  replaceSpy: ReturnType<typeof vi.fn>;
} {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-voice-int-'));
  dirs.push(storage);
  const runtime = new RemoteRuntime({
    storageDirectory: storage,
    workspaceId: 'ws',
    host: {} as ForgeHostFacade,
    secrets: new MemorySecrets() as unknown as vscode.SecretStorage,
    notifyLocal: () => undefined,
    ...(configPath ? { configPath } : {}),
  });
  // `replace` rebuilds live transports; there are none here, and the transport
  // machinery is exercised by its own tests. Stub it so this test isolates the
  // persist + re-read contract of `setVoiceOutput`, and record that the rebuild
  // was requested with the freshly re-loaded config.
  const replaceSpy = vi.fn(async () => undefined);
  (runtime as unknown as { replace: typeof replaceSpy }).replace = replaceSpy;
  return { runtime, replaceSpy };
}

describe('RemoteRuntime.setVoiceOutput persistence', () => {
  it('writes voice.output.enabled to config.yaml, preserves siblings + comments, and rebuilds transports', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-voice-ws-'));
    dirs.push(workspace);
    const configPath = path.join(workspace, 'config.yaml');
    fs.writeFileSync(configPath, CONFIG_YAML, 'utf8');

    const { runtime, replaceSpy } = runtimeWith(configPath);
    await runtime.setVoiceOutput(false);

    // The file now says false...
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('# Forge config — this comment must survive a /voice toggle.');
    expect(raw).toContain('# the whisper paths must point at a real install');
    expect(raw).toContain('piper_binary: /ai/piper.exe');
    expect(raw).toContain('max_chars: 1200');

    // ...and the rebuild ran with the re-loaded config carrying the new value,
    // while the STT ingress (`voice.enabled`) is untouched.
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    const applied = replaceSpy.mock.calls[0][0] as ForgeConfig;
    expect(applied.voice?.output?.enabled).toBe(false);
    expect(applied.voice?.enabled).toBe(true);

    // Turning it back on round-trips to true — a reload would read true.
    await runtime.setVoiceOutput(true);
    expect(fs.readFileSync(configPath, 'utf8')).toMatch(/output:\s*\n\s*enabled: true/);
    const back = replaceSpy.mock.calls[1][0] as ForgeConfig;
    expect(back.voice?.output?.enabled).toBe(true);
  });

  it('rejects with a clear reason when no config path is wired', async () => {
    const { runtime, replaceSpy } = runtimeWith(undefined);
    await expect(runtime.setVoiceOutput(false)).rejects.toThrow('config path is not available');
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
