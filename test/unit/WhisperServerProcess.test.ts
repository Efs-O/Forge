import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeWhisperServerArgs,
  WhisperServerProcess,
  type WhisperServerProcessOptions,
} from '../../src/voice/WhisperServerProcess';

const tempDirs: string[] = [];

function fixtureOptions(
  overrides: Partial<WhisperServerProcessOptions> = {},
): WhisperServerProcessOptions {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-whisper-process-'));
  tempDirs.push(dir);
  const binary = path.join(dir, 'whisper-server.exe');
  const model = path.join(dir, 'large-v3.bin');
  fs.writeFileSync(binary, 'exe');
  fs.writeFileSync(model, 'model');
  return { binary, model, confirmOnStart: false, ...overrides };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.pid = 42;
  child.kill = vi.fn(() => true);
  return child as unknown as ChildProcess;
}

function startsHealthy(child: ChildProcess): {
  fetchFn: typeof fetch;
  spawnFn: (binary: string, args: string[]) => ChildProcess;
} {
  let probes = 0;
  const fetchFn = vi.fn(async () => {
    probes++;
    if (probes === 1) throw new Error('not listening');
    return new Response('<html>whisper.cpp</html>');
  }) as unknown as typeof fetch;
  return { fetchFn, spawnFn: vi.fn(() => child) };
}

describe('WhisperServerProcess', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps model, endpoint and compute settings onto whisper-server argv', () => {
    expect(
      composeWhisperServerArgs({
        binary: 'server',
        model: 'model.bin',
        host: '127.0.0.1',
        port: 9000,
        gpuDevice: 2,
        threads: 8,
        beamSize: 1,
        flashAttn: false,
      }),
    ).toEqual([
      '-m',
      'model.bin',
      '--host',
      '127.0.0.1',
      '--port',
      '9000',
      '-dev',
      '2',
      '-t',
      '8',
      '-bs',
      '1',
      '-nfa',
    ]);
  });

  it('requires explicit approval before spawning', async () => {
    const spawnFn = vi.fn(() => fakeChild());
    const process = new WhisperServerProcess(
      fixtureOptions({
        confirmOnStart: true,
        confirmStart: async () => false,
        fetchFn: vi.fn(async () => {
          throw new Error('free');
        }) as unknown as typeof fetch,
        spawnFn,
      }),
    );
    await expect(process.start()).rejects.toThrow(/cancelled/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('cannot spawn after disposal while confirmation is still open', async () => {
    let approve: ((value: boolean) => void) | undefined;
    const spawnFn = vi.fn(() => fakeChild());
    const process = new WhisperServerProcess(
      fixtureOptions({
        confirmOnStart: true,
        confirmStart: () => new Promise<boolean>((resolve) => (approve = resolve)),
        fetchFn: vi.fn(async () => {
          throw new Error('free');
        }) as unknown as typeof fetch,
        spawnFn,
      }),
    );
    const starting = process.start();
    await vi.waitFor(() => expect(approve).toBeTypeOf('function'));
    await process.dispose();
    approve?.(true);
    await expect(starting).rejects.toThrow(/disposed/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('fails loudly on readiness timeout and terminates the child', async () => {
    const child = fakeChild();
    const terminateFn = vi.fn(async () => undefined);
    const process = new WhisperServerProcess(
      fixtureOptions({
        startupTimeoutMs: 0,
        fetchFn: vi.fn(async () => {
          throw new Error('not ready');
        }) as unknown as typeof fetch,
        spawnFn: () => child,
        terminateFn,
      }),
    );
    await expect(process.start()).rejects.toThrow(/did not become ready/);
    expect(terminateFn).toHaveBeenCalledWith(child);
  });

  it('does not idle-stop while activity is in flight, then unloads afterward', async () => {
    const child = fakeChild();
    const terminateFn = vi.fn(async () => undefined);
    const lifecycle = startsHealthy(child);
    const process = new WhisperServerProcess(
      fixtureOptions({ ...lifecycle, idleTimeoutMs: 15, terminateFn }),
    );
    let release: (() => void) | undefined;
    const active = process.withActivity(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(terminateFn).not.toHaveBeenCalled();
    release?.();
    await active;
    await vi.waitFor(() => expect(terminateFn).toHaveBeenCalledWith(child));
  });

  it('dispose terminates a ready owned process', async () => {
    const child = fakeChild();
    const terminateFn = vi.fn(async () => undefined);
    const process = new WhisperServerProcess(
      fixtureOptions({ ...startsHealthy(child), idleTimeoutMs: 0, terminateFn }),
    );
    await process.withActivity(async () => undefined);
    await process.dispose();
    expect(terminateFn).toHaveBeenCalledWith(child);
  });
});
