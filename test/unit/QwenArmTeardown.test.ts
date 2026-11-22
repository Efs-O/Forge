import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkOrUnloadChatNode,
  releaseForgeQwen,
} from '../../src/benchmark/qwenServerLifecycle';

const tempDirs: string[] = [];
const savedLocalAppData = process.env.LOCALAPPDATA;

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocalAppData;
});

/**
 * Publish the control server's discovery record (and so its bearer token) in a
 * temp folder: `controlServerRegistryPath()` prefers `LOCALAPPDATA`, so this
 * pins the record on every platform and keeps the test out of the real one.
 */
function controlRegistry(token: string): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-qwen-registry-'));
  tempDirs.push(directory);
  fs.mkdirSync(path.join(directory, 'forge-llm'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'forge-llm', 'control-server.json'),
    JSON.stringify({
      url: 'http://127.0.0.1:8799',
      pid: 1,
      startedAt: '2026-11-22T00:00:00.000Z',
      version: '0.17.209',
      token,
    }),
  );
  process.env.LOCALAPPDATA = directory;
}

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

/**
 * Every model route has demanded the control token since 0.17.207 (`6dbf7b8a`),
 * and the benchmark is an external client of them. Sending nothing meant two
 * failures: `/models` answered 401, `fetchChatNodeEntry` read that as "no model
 * loaded", and the guard that stops a minimal server starting beside a resident
 * 13 GB model stopped firing at all (BL-045).
 */
describe('the control-server token on the benchmark\'s model routes', () => {
  it('authenticates /release with the published token', async () => {
    controlRegistry('test-token');
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(String((init?.headers as Record<string, string>)?.authorization));
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }),
    );

    await releaseForgeQwen(
      { phase: 'forge', endpoint: 'http://127.0.0.1:8082', logicalModel: 'qwen', facts: {} } as never,
      configPath(),
    );

    expect(seen).toEqual(['Bearer test-token']);
  });

  it('refuses to guess when /models is refused instead of reading it as idle', async () => {
    controlRegistry('test-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: 'missing or stale token' }),
      }) as unknown as Response),
    );

    // Before the fix this resolved: a 401 became `null`, `!entry?.loaded` was
    // true, and the minimal arm started beside whatever the chat node holds.
    await expect(checkOrUnloadChatNode(configPath(), 'qwen', false)).rejects.toThrow(
      /refused http:\/\/127\.0\.0\.1:8799\/models \(401\)/u,
    );
  });

  it('prints a hand-unload command that reads the token instead of carrying it', async () => {
    controlRegistry('test-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'qwen', loaded: true, holds: 0 }] }),
      }) as unknown as Response),
    );

    const message = await checkOrUnloadChatNode(configPath(), 'qwen', false).catch(
      (error: unknown) => String((error as Error).message),
    );
    // This text reaches recordSkippedArm, so it lands in the bench run directory
    // on disk and in CI logs: the live bearer token must never be in it.
    expect(message).not.toContain('test-token');
    expect(message).toContain("readFileSync('");
    expect(message).toContain("'authorization':'Bearer '+t");
  });

  it('says what to do when the token it sent has gone stale', async () => {
    controlRegistry('stale-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: 'missing or stale token' }),
      }) as unknown as Response),
    );

    await expect(
      releaseForgeQwen(
        { phase: 'forge', endpoint: 'http://127.0.0.1:8082', logicalModel: 'qwen', facts: {} } as never,
        configPath(),
      ),
    ).rejects.toThrow(/stale: restart Forge/u);
  });
});
