import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { SdServerBackend, type SdServerBackendDeps } from '../../src/backend/SdServerBackend';
import {
  sdServerRecordPath,
  writeSdServerRecord,
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

/**
 * Criterion 9's other half. Phase 0b measured that dropping the HTTP connection
 * does not cancel an sd.cpp render, so the only way to free the card after an
 * aborted turn is to kill the server — which is safe only when no other window
 * could have a render in flight. These tests pin that decision, not the fetch.
 */

const MODEL_FIELDS = {
  binary: 'sd-server.exe',
  diffusion_model: 'diffusion.gguf',
  text_encoder: 'text-encoder.gguf',
  vae: 'vae.safetensors',
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sd-abort-'));
  for (const file of Object.values(MODEL_FIELDS)) fs.writeFileSync(path.join(root, file), 'test');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function localConfig(): SdcppImageBackendConfig {
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
        idle_timeout_ms: 600_000,
        request_timeout_ms: 300_000,
        defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 1024, height: 1024 },
        extra_args: [],
        confirm_on_start: true,
        confirm_each: false,
      },
    ],
  });
  const backend = parsed.backends[0];
  if (!backend || backend.provider !== 'sdcpp') throw new Error('config did not parse as sdcpp.');
  return backend;
}

interface Rig {
  backend: SdServerBackend;
  config: SdcppImageBackendConfig;
  kill: ReturnType<typeof vi.fn>;
  processes: Map<number, SdProcessIdentity>;
  recordDir: string;
  recordPath: string;
  setNow: (value: number) => void;
}

function rig(
  options: { ownerPid?: number; startNow?: number; processes?: Map<number, SdProcessIdentity> } = {},
): Rig {
  const config = localConfig();
  const ownerPid = options.ownerPid ?? 100;
  const processes =
    options.processes ??
    new Map<number, SdProcessIdentity>([[ownerPid, { executablePath: 'Forge.exe', createdAt: ownerPid * 10 }]]);
  if (!processes.has(ownerPid)) {
    processes.set(ownerPid, { executablePath: 'Forge.exe', createdAt: ownerPid * 10 });
  }
  let timestamp = options.startNow ?? 10_000;
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 200,
      exitCode: null as number | null,
      signalCode: null,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    processes.set(200, { executablePath: config.binary, createdAt: 2000 });
    return child;
  });
  const kill = vi.fn(async () => {
    processes.delete(200);
  });
  const fetchImpl = vi.fn(async () => {
    if (!processes.has(200)) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }
    return new Response(JSON.stringify({ model: { path: config.diffusion_model } }));
  }) as unknown as typeof fetch;
  const recordDir = path.join(root, 'records');
  const deps: SdServerBackendDeps = {
    spawn,
    fetch: fetchImpl,
    lookupProcess: async (pid) => processes.get(pid),
    killProcess: kill,
    now: () => timestamp,
    recordDir,
    ownerPid,
  };
  return {
    backend: new SdServerBackend(config, deps),
    config,
    kill,
    processes,
    recordDir,
    recordPath: sdServerRecordPath(recordDir, config.name),
    setNow: (value) => {
      timestamp = value;
    },
  };
}

describe('sdcpp abort teardown (criterion 9)', () => {
  it('kills its own server once the shared record has been quiet past request_timeout_ms', async () => {
    const server = rig();
    await server.backend.start();
    // The record it wrote at start says "used just now", which is the only
    // cross-window evidence available, so a fresh start is not killable yet.
    server.setNow(10_000 + server.config.request_timeout_ms + 1);
    const note = await server.backend.stopAfterAbort();
    expect(server.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(server.recordPath)).toBe(false);
    expect(note).toContain('Forge stopped its own sd-server');
    await server.backend.dispose();
  });

  it('leaves its own server running when another window used it inside request_timeout_ms', async () => {
    const server = rig();
    await server.backend.start();
    // Another window touched the shared record just now: a render may be in flight.
    const shared = JSON.parse(fs.readFileSync(server.recordPath, 'utf8')) as Record<string, unknown>;
    await writeSdServerRecord(server.recordPath, {
      ...(shared as never),
      lastUsedAt: 10_000 + server.config.request_timeout_ms - 1,
    });
    server.setNow(10_000 + server.config.request_timeout_ms);
    const note = await server.backend.stopAfterAbort();
    expect(server.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(server.recordPath)).toBe(true);
    expect(note).toContain('Another window used this sd-server');
    await server.backend.dispose();
  });

  it('never stops a server it only adopted, and says whose it is', async () => {
    const owner = rig();
    await owner.backend.start();
    const adopter = rig({ ownerPid: 101, processes: owner.processes });
    await adopter.backend.start();
    const note = await adopter.backend.stopAfterAbort();
    expect(adopter.kill).not.toHaveBeenCalled();
    expect(adopter.processes.has(200)).toBe(true);
    expect(note).toContain('belongs to another Forge window');
    await adopter.backend.dispose();
    await owner.backend.dispose();
  });

  it('says the card is already free when it owns no process', async () => {
    const server = rig();
    const note = await server.backend.stopAfterAbort();
    expect(server.kill).not.toHaveBeenCalled();
    expect(note).toContain('the GPU is already free');
    await server.backend.dispose();
  });
});
