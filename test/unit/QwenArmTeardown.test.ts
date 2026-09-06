import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseForgeQwen } from '../../src/benchmark/qwenServerLifecycle';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** A config with just the fields the lifecycle helpers read. */
function configPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-qwen-teardown-'));
  tempDirs.push(directory);
  const file = path.join(directory, 'config.yaml');
  fs.writeFileSync(
    file,
    [
      'control_server:',
      '  enabled: true',
      '  port: 8799',
      'llama_server:',
      '  binary: C:/llama/llama-server.exe',
      'models:',
      '  - name: qwen',
      '    provider: llama.cpp',
      '    gguf_path: C:/models/qwen.gguf',
      'active_model: qwen',
      '',
    ].join('\n'),
  );
  return file;
}

/**
 * Ending a shared-server arm must not evict the chat node.
 *
 * `unloadForgeQwen` exists to free VRAM for the standalone `qwen-minimal`
 * server. Run without that arm it does nothing but take the sidebar's model
 * down, and Forge brings it back on the NEXT pool port behind a new
 * controller. On 2026-09-05 that unload fired seven times in an afternoon;
 * one of them landed while an agent was monitoring the run and left it
 * dialling a dead port.
 */
describe('qwen-forge teardown', () => {
  it('releases the hold without unloading the model', async () => {
    const routes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        routes.push(new URL(url).pathname);
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }),
    );

    await releaseForgeQwen(
      { phase: 'forge', endpoint: 'http://127.0.0.1:8082', logicalModel: 'qwen', facts: {} } as never,
      configPath(),
    );

    // Exactly one call, and it is /release. An /unload here is the bug.
    expect(routes).toEqual(['/release']);
  });

  it('surfaces a control-server refusal instead of swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'no such hold' }) }) as never),
    );

    await expect(
      releaseForgeQwen(
        { phase: 'forge', endpoint: 'http://127.0.0.1:8082', logicalModel: 'qwen', facts: {} } as never,
        configPath(),
      ),
    ).rejects.toThrow(/\/release failed/);
  });
});
