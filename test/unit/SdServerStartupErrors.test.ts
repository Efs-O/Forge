import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { SdServerBackend, type SdServerBackendDeps } from '../../src/backend/SdServerBackend';
import { sdServerRecordPath, type SdProcessIdentity } from '../../src/backend/sdServerOwnerRecord';
import type { SdcppImageBackendConfig } from '../../src/config/types';
import { SDCPP_MODEL_FIELDS, sdcppBackendConfig } from '../support/sdServerFixtures';

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
 * Criterion 8's startup rows: an unstartable binary and a server that dies
 * before it answers. Each message must name the config key, because that is the
 * thing the user can actually edit.
 */

let root: string;
let recordDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sd-startup-'));
  recordDir = path.join(root, 'records');
  for (const file of Object.values(SDCPP_MODEL_FIELDS)) fs.writeFileSync(path.join(root, file), 'test');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function localConfig(overrides: Record<string, unknown> = {}): SdcppImageBackendConfig {
  return sdcppBackendConfig(root, overrides);
}

interface Rig {
  backend: SdServerBackend;
  processes: Map<number, SdProcessIdentity>;
  spawn: ReturnType<typeof vi.fn>;
}

/**
 * `spawnImpl` decides what the spawn does; the process table starts with only
 * the Forge owner, so a spawned pid is invisible until the spawn registers it —
 * which is what makes the identity check meaningful.
 */
function rig(config: SdcppImageBackendConfig, spawnImpl?: (binary: string) => ChildProcess): Rig {
  const processes = new Map<number, SdProcessIdentity>([
    [100, { executablePath: 'Forge.exe', createdAt: 1000 }],
  ]);
  const spawn = vi.fn((binary: string) => {
    const child = spawnImpl
      ? spawnImpl(binary)
      : Object.assign(new EventEmitter(), {
          pid: 200,
          exitCode: null as number | null,
          signalCode: null,
          stderr: new PassThrough(),
          stdout: new PassThrough(),
          kill: vi.fn(() => true),
        });
    processes.set(child.pid ?? -1, { executablePath: binary, createdAt: 2000 });
    return child;
  });
  const deps: SdServerBackendDeps = {
    spawn: spawn as unknown as SdServerBackendDeps['spawn'],
    fetch: vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }) as unknown as typeof fetch,
    lookupProcess: async (pid) => processes.get(pid),
    killProcess: async () => undefined,
    recordDir,
    ownerPid: 100,
  };
  return { backend: new SdServerBackend(config, deps), processes, spawn };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('sdcpp startup errors name the config key (criterion 8)', () => {
  it('names the binary key when the configured executable cannot be started', async () => {
    const config = localConfig();
    const { backend, spawn } = rig(config, () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    });
    await expect(backend.start()).rejects.toThrow(
      new RegExp(
        `image_generation\\.backends\\.qwen-local\\.binary "${escaped(config.binary)}" could not be started`,
      ),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    await backend.dispose();
  });

  it('names the binary key and the server stderr when it exits during startup', async () => {
    const config = localConfig();
    let child!: ChildProcess;
    const { backend } = rig(config, () => {
      child = Object.assign(new EventEmitter(), {
        pid: 200,
        exitCode: null as number | null,
        signalCode: null,
        stderr: new PassThrough(),
        stdout: new PassThrough(),
        kill: vi.fn(() => true),
      }) as unknown as ChildProcess;
      return child;
    });

    const started = backend.start();
    // Let the owner record be written, so the exit lands inside the readiness
    // wait rather than during identity verification.
    await vi.waitFor(() =>
      expect(fs.existsSync(sdServerRecordPath(recordDir, config.name))).toBe(true),
    );
    child.stderr?.write('ggml_cuda_init: cannot allocate on device 2\n');
    (child as ChildProcess & { exitCode: number | null }).exitCode = 1;
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow(
      new RegExp(
        `image_generation\\.backends\\.qwen-local\\.binary "${escaped(config.binary)}": ` +
          'sd-server exited during startup.*cannot allocate on device 2',
      ),
    );
    await backend.dispose();
  });

  it('refuses a configured path that is not there, before spawning anything', async () => {
    const missing = path.join(root, 'absent-vae.safetensors');
    const { backend, spawn } = rig(localConfig({ vae: missing }));
    await expect(backend.start()).rejects.toThrow(
      new RegExp(
        `image_generation\\.backends\\.qwen-local\\.vae: configured path "${escaped(missing)}" is unavailable`,
      ),
    );
    expect(spawn).not.toHaveBeenCalled();
    await backend.dispose();
  });
});
