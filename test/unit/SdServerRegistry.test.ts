import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { SdServerRegistry } from '../../src/backend/sdServerRegistry';
import { sdServerRecordPath, type SdProcessIdentity } from '../../src/backend/sdServerOwnerRecord';
import type { ForgeConfig, SdcppImageBackendConfig } from '../../src/config/types';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

const MODEL_FIELDS = {
  binary: 'sd-server.exe',
  diffusion_model: 'diffusion.gguf',
  text_encoder: 'text-encoder.gguf',
  vae: 'vae.safetensors',
};

let root: string;
let recordDir: string;
const realPlatform = process.platform;

// The registry skips sdcpp backends off Windows (sd-server ships as a Windows
// binary), so every lifecycle case here runs as win32 whatever the CI host is.
const setPlatform = (value: string): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

beforeEach(() => {
  setPlatform('win32');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sd-registry-'));
  recordDir = path.join(root, 'records');
  for (const file of Object.values(MODEL_FIELDS)) fs.writeFileSync(path.join(root, file), 'test');
});

afterEach(() => {
  setPlatform(realPlatform);
  fs.rmSync(root, { recursive: true, force: true });
});

function backendConfig(overrides: Record<string, unknown> = {}): SdcppImageBackendConfig {
  const parsed = ImageGenerationConfigSchema.parse({
    backends: [
      {
        name: 'qwen-local',
        provider: 'sdcpp',
        binary: path.join(root, MODEL_FIELDS.binary),
        diffusion_model: path.join(root, MODEL_FIELDS.diffusion_model),
        text_encoder: path.join(root, MODEL_FIELDS.text_encoder),
        vae: path.join(root, MODEL_FIELDS.vae),
        cuda_device: 2,
        text_encoder_on_cpu: true,
        port: 8093,
        min_free_vram_mb: 7000,
        idle_timeout_ms: 61_000,
        request_timeout_ms: 1000,
        defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 1024, height: 1024 },
        extra_args: [],
        confirm_on_start: true,
        confirm_each: false,
        ...overrides,
      },
    ],
  });
  const backend = parsed.backends[0];
  if (!backend || backend.provider !== 'sdcpp') throw new Error('config did not parse as sdcpp.');
  return backend;
}

function forgeConfig(...backends: SdcppImageBackendConfig[]): ForgeConfig {
  return { image_generation: { backends } } as unknown as ForgeConfig;
}

interface Rig {
  registry: SdServerRegistry;
  spawn: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  processes: Map<number, SdProcessIdentity>;
}

/** One fake process table for the whole registry, so a child is really one process. */
function rig(...backends: SdcppImageBackendConfig[]): Rig {
  const processes = new Map<number, SdProcessIdentity>([
    [100, { executablePath: 'Forge.exe', createdAt: 1000 }],
  ]);
  // Which executable answers which port, so a probe for a port nobody bound is
  // refused rather than "answered" by another backend's server.
  const binaryByPort = new Map(backends.map((backend) => [backend.port, backend.binary]));
  const children: ChildProcess[] = [];
  let nextPid = 200;
  const spawn = vi.fn((binary: string) => {
    const pid = nextPid++;
    const child = Object.assign(new EventEmitter(), {
      pid,
      exitCode: null as number | null,
      signalCode: null,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    children.push(child);
    processes.set(pid, { executablePath: binary, createdAt: pid * 10 });
    return child;
  });
  const kill = vi.fn(async (child: ChildProcess) => {
    processes.delete(child.pid ?? -1);
    (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
  });
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const port = Number(new URL(String(url)).port);
    const binary = binaryByPort.get(port);
    const live =
      binary !== undefined &&
      [...processes.entries()].some(
        ([pid, identity]) => identity.executablePath === binary && pid !== 100,
      );
    if (!live) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }
    return new Response(JSON.stringify({ model: { path: 'not-checked-here' } }));
  }) as unknown as typeof fetch;

  const registry = new SdServerRegistry(forgeConfig(...backends), {
    spawn,
    fetch: fetchImpl,
    lookupProcess: async (pid) => processes.get(pid),
    killProcess: kill,
    recordDir,
    ownerPid: 100,
  });
  return { registry, spawn, kill, processes };
}

describe('SdServerRegistry lifecycle (ledger row 1)', () => {
  it('builds one handle per sdcpp backend and none for a cloud one', () => {
    const { registry } = rig(backendConfig());
    expect([...registry.handles().keys()]).toEqual(['qwen-local']);
    expect(registry.handles().get('qwen-local')?.baseUrl()).toBe('http://127.0.0.1:8093');
    registry.dispose();
  });

  it('stops the process and deletes the record when the backend is removed from config', async () => {
    const config = backendConfig();
    const { registry, spawn, kill } = rig(config);
    await registry.handles().get('qwen-local')?.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    const recordPath = sdServerRecordPath(recordDir, config.name);
    expect(fs.existsSync(recordPath)).toBe(true);

    registry.applyForgeConfig({ image_generation: undefined } as unknown as ForgeConfig);
    expect(registry.handles().size).toBe(0);
    await vi.waitFor(() => {
      expect(kill).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(recordPath)).toBe(false);
    });
    registry.dispose();
  });

  it('replaces a handle whose config changed, keeping an unchanged one warm', async () => {
    const config = backendConfig();
    const { registry, spawn, kill } = rig(config);
    const first = registry.handles().get('qwen-local');
    await first?.start();

    registry.applyForgeConfig(forgeConfig(config));
    expect(registry.handles().get('qwen-local')).toBe(first);
    expect(kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);

    // A timeout change matters to teardown safety, so it must rebuild the handle.
    registry.applyForgeConfig(forgeConfig(backendConfig({ idle_timeout_ms: 400_000 })));
    const second = registry.handles().get('qwen-local');
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
    expect(first.startApproval()).toBeUndefined();
    registry.dispose();
  });

  it('stops every server on dispose, and ignores a later reload', async () => {
    const flux = path.join(root, 'sd-server-flux.exe');
    fs.writeFileSync(flux, 'test');
    const { registry, kill } = rig(
      backendConfig(),
      backendConfig({ name: 'flux-local', port: 8094, binary: flux }),
    );
    expect([...registry.handles().keys()]).toEqual(['qwen-local', 'flux-local']);
    await Promise.all([...registry.handles().values()].map((handle) => handle.start()));
    registry.dispose();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(2));
    registry.applyForgeConfig(forgeConfig(backendConfig()));
    expect(registry.handles().size).toBe(0);
  });
});
