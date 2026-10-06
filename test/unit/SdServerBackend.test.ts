import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import {
  SdServerBackend,
  composeSdServerArgs,
  sdServerSignature,
  type SdServerBackendDeps,
} from '../../src/backend/SdServerBackend';
import {
  writeSdServerRecord,
  sdServerRecordPath,
  type SdProcessIdentity,
} from '../../src/backend/sdServerOwnerRecord';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';
import type { SdcppImageBackendConfig } from '../../src/config/types';

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

let root: string;
let backendInstances: SdServerBackend[];

const MODEL_FIELDS = {
  binary: 'sd-server.exe',
  diffusion_model: 'diffusion.gguf',
  text_encoder: 'text-encoder.gguf',
  vae: 'vae.safetensors',
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sd-test-'));
  backendInstances = [];
  for (const file of Object.values(MODEL_FIELDS)) fs.writeFileSync(path.join(root, file), 'test');
});

afterEach(async () => {
  vi.useRealTimers();
  for (const backend of backendInstances) await backend.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function localConfig(overrides: Record<string, unknown> = {}): SdcppImageBackendConfig {
  const result = ImageGenerationConfigSchema.parse({
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
        extra_args: ['--extra-option', 'value'],
        confirm_on_start: true,
        confirm_each: false,
        ...overrides,
      },
    ],
  });
  const config = result.backends[0];
  if (!config || config.provider !== 'sdcpp')
    throw new Error('test config did not parse as sdcpp.');
  return config;
}

function makeChild(pid: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null,
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child as unknown as ChildProcess;
}

interface Rig {
  backend: SdServerBackend;
  config: SdcppImageBackendConfig;
  spawn: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  processes: Map<number, SdProcessIdentity>;
  recordDir: string;
}

function rig(
  config = localConfig(),
  options: {
    ownerPid?: number;
    now?: () => number;
    fetch?: typeof fetch;
    processes?: Map<number, SdProcessIdentity>;
    nextPid?: number;
    terminate?: (pid: number) => Promise<void>;
  } = {},
): Rig {
  const processes =
    options.processes ??
    new Map<number, SdProcessIdentity>([[100, { executablePath: 'Forge.exe', createdAt: 1000 }]]);
  const ownerPid = options.ownerPid ?? 100;
  if (!processes.has(ownerPid)) {
    processes.set(ownerPid, { executablePath: 'Forge.exe', createdAt: ownerPid * 10 });
  }
  const children: ChildProcess[] = [];
  let nextPid = options.nextPid ?? 200;
  const spawn = vi.fn((_binary: string, _args: string[], _env?: NodeJS.ProcessEnv) => {
    const child = makeChild(nextPid++);
    children.push(child);
    processes.set(child.pid!, { executablePath: config.binary, createdAt: child.pid! * 10 });
    return child;
  });
  const kill = vi.fn(async (child: ChildProcess) => {
    processes.delete(child.pid ?? -1);
    (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
  });
  const terminate = vi.fn(async (pid: number) => {
    if (options.terminate) await options.terminate(pid);
    else processes.delete(pid);
  });
  const ready = new Response(JSON.stringify({ model: { path: config.diffusion_model } }));
  const fetchImpl =
    options.fetch ??
    (vi.fn(async () => {
      if (spawn.mock.calls.length === 0) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      }
      return ready.clone();
    }) as unknown as typeof fetch);
  const recordDir = path.join(root, 'records');
  const deps: SdServerBackendDeps = {
    spawn,
    fetch: fetchImpl,
    lookupProcess: async (pid) => processes.get(pid),
    terminateProcess: terminate,
    killProcess: kill,
    now: options.now,
    recordDir,
    ownerPid,
  };
  const backend = new SdServerBackend(config, deps);
  backendInstances.push(backend);
  return { backend, config, spawn, kill, terminate, processes, recordDir };
}

describe('sdcpp image_generation schema', () => {
  it('keeps today’s cloud backend shape valid and enforces the timeout boundary', () => {
    const cloud = ImageGenerationConfigSchema.parse({
      backends: [{ name: 'xai-image', provider: 'xai', model: 'grok-imagine-image-2.0' }],
    });
    expect(cloud.backends[0]).toMatchObject({ provider: 'xai', confirm_each: true });

    expect(() =>
      ImageGenerationConfigSchema.parse({
        backends: [
          {
            ...localConfig(),
            request_timeout_ms: 1000,
            idle_timeout_ms: 60_999,
          },
        ],
      }),
    ).toThrow(/idle_timeout_ms/);
    expect(
      ImageGenerationConfigSchema.safeParse({
        backends: [{ ...localConfig(), request_timeout_ms: 1000, idle_timeout_ms: 61_000 }],
      }).success,
    ).toBe(true);
  });

  it.each(['binary', 'diffusion_model', 'text_encoder', 'vae'])(
    'names the required %s path when it is absent',
    (key) => {
      const backend = { ...localConfig() } as Record<string, unknown>;
      delete backend[key];
      const result = ImageGenerationConfigSchema.safeParse({ backends: [backend] });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
          `backends.0.${key}`,
        );
    },
  );
});

describe('SdServerBackend startup and lifecycle', () => {
  // A1: an explicit argv snapshot for a config carrying NONE of the new keys.
  // "Existing cases pass untouched" cannot fail if those cases never asserted
  // the args, so the shipped defaults are pinned here rather than inferred.
  it('isolates the CUDA device and uses the required loopback, auto-fit, and backend args', async () => {
    const server = rig();
    expect(server.backend.startApproval()?.detail).toContain('7 GB free VRAM');
    await server.backend.start();
    const [binary, args, env] = server.spawn.mock.calls[0] as [string, string[], NodeJS.ProcessEnv];
    expect(binary).toBe(server.config.binary);
    expect(env).toMatchObject({
      CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
      CUDA_VISIBLE_DEVICES: '2',
    });
    expect(args).toContain('--auto-fit');
    // Phase 1: auto-fit on is the shipped default (measured 410s vs 549s for the
    // same render), and it can only place work on the isolated card or in RAM.
    expect(args[args.indexOf('--auto-fit') + 1]).toBe('on');
    expect(args).toContain('--listen-ip');
    expect(args[args.indexOf('--listen-ip') + 1]).toBe('127.0.0.1');
    expect(args).toContain('--fa');
    expect(args[args.indexOf('--backend') + 1]).toBe('te=cpu,diffusion=cuda0,vae=cuda0');
    expect(args.slice(-2)).toEqual(['--extra-option', 'value']);
    // Absent config keys mean the flags are absent, not defaulted to a number:
    // sd-server keeps its own budget and no vision tower.
    expect(args).not.toContain('--max-vram');
    expect(args).not.toContain('--llm_vision');
    expect(composeSdServerArgs({ ...server.config, text_encoder_on_cpu: false })).toContain(
      'te=cuda0,diffusion=cuda0,vae=cuda0',
    );
  });

  // A3 + A5: the new keys reach the spawn args, and changing them changes the
  // signature so a server started under the old ones is never adopted.
  it('emits --auto-fit off, --max-vram and --llm_vision only when configured, and changes the signature', () => {
    const base = rig().config;
    const plain = composeSdServerArgs(base);
    expect(plain).not.toContain('--max-vram');
    expect(plain).not.toContain('--llm_vision');

    const tuned = {
      ...base,
      auto_fit: false,
      max_vram_gib: 11,
      vision_encoder: path.join(root, 'mmproj.gguf'),
    };
    const tunedArgs = composeSdServerArgs(tuned);
    expect(tunedArgs[tunedArgs.indexOf('--auto-fit') + 1]).toBe('off');
    expect(tunedArgs[tunedArgs.indexOf('--max-vram') + 1]).toBe('11');
    expect(tunedArgs[tunedArgs.indexOf('--llm_vision') + 1]).toBe(path.join(root, 'mmproj.gguf'));

    expect(sdServerSignature(tuned)).not.toBe(sdServerSignature(base));
    expect(sdServerSignature({ ...base, auto_fit: false })).not.toBe(sdServerSignature(base));
    expect(sdServerSignature({ ...base, max_vram_gib: 9 })).not.toBe(
      sdServerSignature({ ...base, max_vram_gib: 11 }),
    );
  });

  // A4 (missing-path half): an optional key that IS set must be verified, or a
  // typo surfaces at the first reference edit instead of at start.
  it('names vision_encoder when the configured vision tower is missing', async () => {
    const server = rig(localConfig({ vision_encoder: path.join(root, 'mmproj-typo.gguf') }));
    await expect(server.backend.start()).rejects.toThrow(
      /vision_encoder.*mmproj-typo\.gguf.*unavailable/s,
    );
    expect(server.spawn).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent starts and holds the process while activity is in flight', async () => {
    vi.useFakeTimers();
    const server = rig();
    let finish!: () => void;
    const active = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started: Array<Promise<void>> = [];
    const first = server.backend.withActivity(async () => {
      started.push(Promise.resolve());
      await active;
    });
    const second = server.backend.withActivity(async () => {
      await active;
    });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(server.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(server.config.idle_timeout_ms);
    expect(server.kill).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    const recordPath = sdServerRecordPath(server.recordDir, server.config.name);
    const current = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as {
      pid: number;
      pidCreatedAt: number;
      port: number;
      binary: string;
      diffusionModel: string;
      signature: string;
      ownerPid: number;
      ownerCreatedAt: number;
      startedAt: number;
      lastUsedAt: number;
    };
    await writeSdServerRecord(recordPath, { ...current, lastUsedAt: Date.now() + 30_000 });
    await vi.advanceTimersByTimeAsync(server.config.idle_timeout_ms - 1);
    expect(server.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(server.kill).toHaveBeenCalledTimes(1));
  });

  it('disposes the owned process and removes its record', async () => {
    const server = rig();
    await server.backend.start();
    const recordPath = sdServerRecordPath(server.recordDir, server.config.name);
    expect(fs.existsSync(recordPath)).toBe(true);
    await server.backend.dispose();
    expect(server.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it('names the config key and unavailable path when a configured model file is missing', async () => {
    const missing = path.join(root, 'missing-diffusion.gguf');
    const server = rig(localConfig({ diffusion_model: missing }));
    await expect(server.backend.start()).rejects.toThrow(
      new RegExp(`diffusion_model.*${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    expect(server.spawn).not.toHaveBeenCalled();
  });

  it('removes a crashed child record so the next start can respawn', async () => {
    const config = localConfig();
    const processes = new Map<number, SdProcessIdentity>([
      [100, { executablePath: 'Forge.exe', createdAt: 1000 }],
    ]);
    const fetchImpl = (async () => {
      const serverIsLive = [...processes.values()].some(
        (identity) => identity.executablePath === config.binary,
      );
      if (!serverIsLive) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      }
      return new Response(JSON.stringify({ model: { path: config.diffusion_model } }));
    }) as typeof fetch;
    const server = rig(config, { processes, fetch: fetchImpl });
    await server.backend.start();
    const recordPath = sdServerRecordPath(server.recordDir, config.name);
    const child = server.spawn.mock.results[0]?.value as ChildProcess | undefined;
    expect(child).toBeDefined();
    processes.delete(child?.pid ?? -1);
    if (child) {
      (child as ChildProcess & { exitCode: number | null }).exitCode = 1;
      child.emit('exit', 1, null);
    }
    await vi.waitFor(() => expect(fs.existsSync(recordPath)).toBe(false));
    await server.backend.start();
    expect(server.spawn).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(recordPath)).toBe(true);
  });
});

describe('SdServerBackend orphan reaping and adoption', () => {
  it('reaps a live matching binary after its owner process dies', async () => {
    const config = localConfig();
    const processes = new Map<number, SdProcessIdentity>([
      [200, { executablePath: config.binary, createdAt: 2000 }],
    ]);
    const server = rig(config, { processes });
    await fs.promises.mkdir(server.recordDir, { recursive: true });
    await writeSdServerRecord(sdServerRecordPath(server.recordDir, config.name), {
      pid: 200,
      pidCreatedAt: 2000,
      port: config.port,
      binary: config.binary,
      diffusionModel: config.diffusion_model,
      signature: 'a'.repeat(64),
      ownerPid: 101,
      ownerCreatedAt: 1010,
      startedAt: 1500,
      lastUsedAt: 1500,
    });
    await server.backend.start();
    expect(server.terminate).toHaveBeenCalledWith(200);
    expect(server.spawn).toHaveBeenCalledTimes(1);
  });

  it('leaves a live pid with a different executable alone and names its pid and port', async () => {
    const config = localConfig();
    const processes = new Map<number, SdProcessIdentity>([
      [200, { executablePath: 'other-server.exe', createdAt: 2000 }],
    ]);
    const server = rig(config, { processes });
    await fs.promises.mkdir(server.recordDir, { recursive: true });
    await writeSdServerRecord(sdServerRecordPath(server.recordDir, config.name), {
      pid: 200,
      pidCreatedAt: 2000,
      port: config.port,
      binary: config.binary,
      diffusionModel: config.diffusion_model,
      signature: 'a'.repeat(64),
      ownerPid: 101,
      ownerCreatedAt: 1010,
      startedAt: 1500,
      lastUsedAt: 1500,
    });
    await expect(server.backend.start()).rejects.toThrow(/pid 200.*port 8093|port 8093.*pid 200/);
    expect(server.terminate).not.toHaveBeenCalled();
    expect(server.spawn).not.toHaveBeenCalled();
  });

  it('does not reap an orphan record while an adopter may still be active', async () => {
    const config = localConfig();
    const processes = new Map<number, SdProcessIdentity>([
      [200, { executablePath: config.binary, createdAt: 2000 }],
    ]);
    const server = rig(config, { processes, now: () => 2000 });
    await fs.promises.mkdir(server.recordDir, { recursive: true });
    await writeSdServerRecord(sdServerRecordPath(server.recordDir, config.name), {
      pid: 200,
      pidCreatedAt: 2000,
      port: config.port,
      binary: config.binary,
      diffusionModel: config.diffusion_model,
      signature: 'a'.repeat(64),
      ownerPid: 101,
      ownerCreatedAt: 1010,
      startedAt: 1500,
      lastUsedAt: 1950,
    });
    await expect(server.backend.start()).rejects.toThrow(/recently used pid 200/);
    expect(server.terminate).not.toHaveBeenCalled();
    expect(server.spawn).not.toHaveBeenCalled();
  });

  it('adopts an answering server, updates lastUsedAt, and never owns its teardown', async () => {
    let timestamp = 2000;
    const first = rig(localConfig(), { now: () => timestamp });
    await first.backend.start();
    const second = rig(first.config, {
      now: () => timestamp,
      ownerPid: 101,
      processes: first.processes,
      nextPid: 300,
      fetch: (async () =>
        new Response(
          JSON.stringify({ model: { path: first.config.diffusion_model } }),
        )) as typeof fetch,
    });
    timestamp = 5000;
    await second.backend.withActivity(async () => {
      const during = JSON.parse(
        fs.readFileSync(sdServerRecordPath(first.recordDir, first.config.name), 'utf8'),
      ) as { lastUsedAt: number };
      expect(during.lastUsedAt).toBe(5000);
      timestamp = 6000;
    });
    const record = JSON.parse(
      fs.readFileSync(sdServerRecordPath(first.recordDir, first.config.name), 'utf8'),
    ) as { lastUsedAt: number };
    expect(record.lastUsedAt).toBe(6000);
    expect(second.spawn).not.toHaveBeenCalled();
    await second.backend.dispose();
    expect(second.kill).not.toHaveBeenCalled();
  });

  it('spawns its own server once the adopted owner has stopped, and keeps a finished result', async () => {
    const first = rig();
    await first.backend.start();
    let secondSpawned = false;
    const second = rig(first.config, {
      ownerPid: 101,
      processes: first.processes,
      nextPid: 300,
      fetch: (async () => {
        if (!first.processes.has(200) && !secondSpawned) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
          });
        }
        return new Response(JSON.stringify({ model: { path: first.config.diffusion_model } }));
      }) as typeof fetch,
    });
    second.spawn.mockImplementationOnce((...args: Parameters<typeof second.spawn>) => {
      secondSpawned = true;
      return second.spawn.getMockImplementation()!(...args);
    });
    // The owner stops mid-render: the end-of-use record touch fails, the image survives.
    const result = await second.backend.withActivity(async () => {
      await first.backend.dispose();
      return 'image';
    });
    expect(result).toBe('image');
    expect(second.spawn).not.toHaveBeenCalled();
    await second.backend.withActivity(async () => undefined);
    expect(second.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses a live owner record with a different signature and names its model and port', async () => {
    const first = rig();
    await first.backend.start();
    const otherModel = path.join(root, 'other-diffusion.gguf');
    fs.writeFileSync(otherModel, 'other model');
    const secondConfig = localConfig({ diffusion_model: otherModel });
    const second = rig(secondConfig, {
      ownerPid: 101,
      processes: first.processes,
      fetch: (async () =>
        new Response(
          JSON.stringify({ model: { path: first.config.diffusion_model } }),
        )) as typeof fetch,
    });
    await expect(second.backend.start()).rejects.toThrow(
      new RegExp(
        `port 8093.*${first.config.diffusion_model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
    );
    expect(second.spawn).not.toHaveBeenCalled();
  });

  // A6 (b): the ledger's misleading-refusal case. Both windows share the model
  // and differ only in vision_encoder — the old wording blamed the model.
  it('says the configuration differs when only vision_encoder differs, not the model', async () => {
    const first = rig();
    await first.backend.start();
    fs.writeFileSync(path.join(root, 'mmproj.gguf'), 'vision tower');
    const second = rig(localConfig({ vision_encoder: path.join(root, 'mmproj.gguf') }), {
      ownerPid: 101,
      processes: first.processes,
      fetch: (async () =>
        new Response(
          JSON.stringify({ model: { path: first.config.diffusion_model } }),
        )) as typeof fetch,
    });
    await expect(second.backend.start()).rejects.toThrow(
      /configuration differs from this one.*Stop that backend here or in the other window/s,
    );
    // It must not blame the model: both windows use the same GGUF, so naming it
    // as the difference is the misdirection this row exists to prevent.
    await expect(second.backend.start()).rejects.not.toThrow(/using model/);
    expect(second.spawn).not.toHaveBeenCalled();
  });
});
