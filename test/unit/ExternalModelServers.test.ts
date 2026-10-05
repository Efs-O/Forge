import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackendPool } from '../../src/backend/BackendPool';
import {
  ExternalModelServers,
  beforeExternalRequest,
  setExternalRequestHook,
  START_TIMEOUT_MS,
  START_POLL_MS,
} from '../../src/backend/ExternalModelServers';
import { deferredStopInvocation, STOP_GRACE_MS } from '../../src/backend/deferredStop';
import { freeLocalForExternal } from '../../src/backend/poolAcquisition';
import { ForgeConfigSchema } from '../../src/config/schema';
import { resolveRequestModel } from '../../src/config/ConfigResolver';
import type { ForgeConfig } from '../../src/config/types';

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    createOutputChannel: () => ({ appendLine: () => {}, clear: () => {}, show: () => {} }),
  },
}));

const events = vi.hoisted(() => [] as string[]);

vi.mock('../../src/backend/DirectBackend', () => {
  class FakeDirectBackend {
    private ready = false;
    constructor(
      _config: unknown,
      private readonly port: number,
    ) {}
    async hotSwap(): Promise<void> {
      events.push(`spawn:${this.port}`);
      this.ready = true;
    }
    async stop(): Promise<void> {
      events.push(`stop:${this.port}`);
      this.ready = false;
    }
    isReady(): boolean {
      return this.ready;
    }
    baseUrl(): string {
      return `http://127.0.0.1:${this.port}`;
    }
    loadedModel(): string | null {
      return null;
    }
    applyForgeConfig(): void {}
    showConsole(): void {}
    async start(): Promise<void> {}
    onUnexpectedExit(): void {}
  }
  return { DirectBackend: FakeDirectBackend };
});

const probeHttpMock = vi.hoisted(() =>
  vi.fn(async () => ({ reachable: false, ok: false })),
);
vi.mock('../../src/backend/HealthCheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/backend/HealthCheck')>();
  return { ...actual, probeHttp: probeHttpMock };
});

function makeConfig(): ForgeConfig {
  return {
    models: [
      { name: 'llama', provider: 'llama.cpp', gguf_path: '/a.gguf' },
      {
        name: 'strata',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8080',
        api_key_secret: 'strata',
        unload_path: '/unload',
      },
      {
        name: 'cloud',
        provider: 'openai-compatible',
        endpoint: 'https://example.invalid/v1',
        api_key_secret: 'cloud',
      },
    ],
    active_model: 'llama',
    llama_server: { port: 9100 },
  } as ForgeConfig;
}

function makeServers(respond: () => Promise<Response>): {
  servers: ExternalModelServers;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    events.push('unload:strata');
    return respond();
  }) as unknown as typeof fetch;
  const config = makeConfig();
  const servers = new ExternalModelServers(
    () => config,
    async (key) => `token-${key}`,
    fetchImpl,
  );
  return { servers, calls };
}

const ok = async (): Promise<Response> => new Response('{"status":"unloaded"}', { status: 200 });

describe('ExternalModelServers', () => {
  beforeEach(() => {
    events.length = 0;
    probeHttpMock.mockReset();
  });

  it('counts an unknown server as loaded, and an unload POST marks it unloaded', async () => {
    const { servers, calls } = makeServers(ok);
    expect(servers.isManaged('strata')).toBe(true);
    expect(servers.isManaged('cloud')).toBe(false);
    expect(servers.isLoaded('strata')).toBe(true);

    await servers.unload('strata');
    expect(calls[0].url).toBe('http://127.0.0.1:8080/unload');
    expect(calls[0].init.method).toBe('POST');
    // Strata's /unload 415s a non-JSON POST (server.py _own_page), so the control
    // POST must declare Content-Type: application/json (with a JSON body), or the
    // unload silently fails and the server keeps holding its VRAM.
    expect(calls[0].init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-strata',
    });
    expect(calls[0].init.body).toEqual('{}');
    expect(servers.isLoaded('strata')).toBe(false);

    servers.markInUse('strata');
    expect(servers.isLoaded('strata')).toBe(true);
  });

  it('confirms loaded only after a request, not while residency is unknown', async () => {
    const { servers } = makeServers(async () => new Response('{"status":"unloaded"}'));
    expect(servers.isLoaded('strata')).toBe(true);
    expect(servers.isConfirmedLoaded('strata')).toBe(false);
    servers.markInUse('strata');
    expect(servers.isConfirmedLoaded('strata')).toBe(true);
    await servers.unload('strata');
    expect(servers.isConfirmedLoaded('strata')).toBe(false);
  });

  it('does not let a late unload completion erase a concurrent request', async () => {
    let finishUnload: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      finishUnload = resolve;
    });
    const { servers, calls } = makeServers(async () => response);

    const unloading = servers.unload('strata');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    servers.markInUse('strata');
    finishUnload?.(new Response('{"status":"unloaded"}', { status: 200 }));
    await unloading;

    expect(servers.isLoaded('strata')).toBe(true);
    await servers.unload('strata');
    expect(calls).toHaveLength(2);
  });

  it('surfaces a busy server instead of claiming it unloaded', async () => {
    const { servers } = makeServers(async () => new Response('{"status":"busy"}', { status: 409 }));
    await expect(servers.unload('strata')).rejects.toThrow(/409 — a request is still running/);
    expect(servers.isLoaded('strata')).toBe(true);
  });

  it('treats a server that is not listening as unloaded', async () => {
    const { servers } = makeServers(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    });
    await servers.unload('strata');
    expect(servers.isLoaded('strata')).toBe(false);
  });

  it('reports any other network failure', async () => {
    const { servers } = makeServers(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(servers.unload('strata')).rejects.toThrow(/Could not unload "strata"/);
  });

  it('launches an injected detached stop command only for the last idle window', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    strata.stop_on_exit = true;
    strata.stop_command = ['stop-strata', '--graceful'];
    const fetchImpl = vi.fn(async () => new Response('{"status":"unloaded"}', { status: 200 }));
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref }));
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl as unknown as typeof fetch,
      spawnImpl,
    );

    await servers.stopOnExit({ lastWindow: false, isBusy: () => false, leaseDir: 'leases' });
    await servers.stopOnExit({ lastWindow: true, isBusy: () => true, leaseDir: 'leases' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();

    await servers.stopOnExit({ lastWindow: true, isBusy: () => false, leaseDir: 'leases' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { command, args, env } = deferredStopInvocation('leases', STOP_GRACE_MS, [
      'stop-strata',
      '--graceful',
    ]);
    expect(spawnImpl).toHaveBeenCalledWith(command, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env,
    });
    expect(unref).toHaveBeenCalledOnce();
  });

  it('cancels the stop watcher when the server reports busy', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    strata.stop_on_exit = true;
    strata.stop_command = ['stop-strata'];
    const kill = vi.fn(() => true);
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), kill }));
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      async () => new Response('{"status":"busy"}', { status: 409 }),
      spawnImpl,
    );

    await servers.stopOnExit({ lastWindow: true, isBusy: () => false, leaseDir: 'leases' });
    expect(kill).toHaveBeenCalledOnce();
  });

  it('keeps the stop watcher when the unload fails for another reason', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    strata.stop_on_exit = true;
    strata.stop_command = ['stop-strata'];
    const kill = vi.fn(() => true);
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), kill }));
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      async () => {
        throw new TypeError('fetch failed');
      },
      spawnImpl,
    );

    await servers.stopOnExit({ lastWindow: true, isBusy: () => false, leaseDir: 'leases' });
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });

  it('stops a managed server only for an explicit unload, after its unload POST', async () => {
    const config = makeConfig();
    config.models[1].stop_command = ['stop-strata'];
    const order: string[] = [];
    const spawnImpl = vi.fn(() => {
      order.push('stop');
      return { unref: vi.fn() };
    });
    const fetchImpl = vi.fn(async () => {
      order.push('unload');
      return new Response('{}', { status: 200 });
    });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl as unknown as typeof fetch,
      spawnImpl,
    );
    const pool = new BackendPool(config, undefined, servers);

    await pool.release('strata'); // model switch: free VRAM, keep the server up
    expect(spawnImpl).not.toHaveBeenCalled();
    probeHttpMock
      .mockResolvedValueOnce({ reachable: true, ok: true })
      .mockResolvedValue({ reachable: false, ok: false });
    await pool.release('strata', true); // /unload, even if already unloaded

    expect(order).toEqual(['unload', 'unload', 'stop']);
    expect(spawnImpl).toHaveBeenCalledWith('stop-strata', [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
  });

  it('never stops a managed server when it refuses unload as busy', async () => {
    const config = makeConfig();
    config.models[1].stop_command = ['stop-strata'];
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      async () => new Response('{}', { status: 409 }),
      spawnImpl,
    );
    const pool = new BackendPool(config, undefined, servers);

    await expect(pool.release('strata', true)).rejects.toThrow(/still running/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('/unloadall stops a configured server even after it was unloaded before', async () => {
    const config = makeConfig();
    config.models[1].stop_command = ['stop-strata'];
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    probeHttpMock
      .mockResolvedValueOnce({ reachable: true, ok: true })
      .mockResolvedValue({ reachable: false, ok: false });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      async () => new Response('{}', { status: 200 }),
      spawnImpl,
    );
    const pool = new BackendPool(config, undefined, servers);
    await servers.unload('strata');

    await pool.stopAll(true);

    expect(spawnImpl).toHaveBeenCalledOnce();
  });

  it('ensureStarted returns immediately when the server is already reachable', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    strata.start_command = ['start-strata', 'hidden'];
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    probeHttpMock.mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      undefined,
      spawnImpl,
    );
    await servers.ensureStarted('strata');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('ensureStarted launches start_command when down, then waits until reachable', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    strata.start_command = ['start-strata', 'hidden'];
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref }));
    // "is it up?" probe → down; first wait-loop probe → up (no polling delay).
    probeHttpMock
      .mockResolvedValueOnce({ reachable: false, ok: false })
      .mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      undefined,
      spawnImpl,
    );
    await servers.ensureStarted('strata');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith('start-strata', ['hidden'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    expect(unref).toHaveBeenCalledOnce();
  });

  it('passes the configured model context through an exact start_command placeholder', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    strata.num_ctx = 154624;
    strata.start_command = ['start-strata', '--max-context', '{num_ctx}'];
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    probeHttpMock
      .mockResolvedValueOnce({ reachable: false, ok: false })
      .mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      undefined,
      spawnImpl,
    );

    await servers.ensureStarted('strata');

    expect(spawnImpl).toHaveBeenCalledWith('start-strata', ['--max-context', '154624'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
  });

  it('surfaces a missing model context when the start command requests it', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    delete strata.num_ctx;
    strata.start_command = ['start-strata', '{num_ctx}'];
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    probeHttpMock
      .mockResolvedValueOnce({ reachable: false, ok: false })
      .mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      undefined,
      spawnImpl,
    );

    await expect(servers.ensureStarted('strata')).rejects.toThrow(
      'start_command uses "{num_ctx}", but "strata" has no valid num_ctx',
    );
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  // Two requests to a down managed server used to both probe "not reachable"
  // and both spawn start_command: two Strata launches racing one port and
  // loading the model into VRAM twice (audit F2, 2026-10-03).
  it('ensureStarted joins one in-flight start instead of spawning twice', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    strata.start_command = ['start-strata', 'hidden'];
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    // Both callers probe "is it up?" and see it down; only the wait-loop probe
    // sees it up, so both would otherwise reach the spawn.
    probeHttpMock
      .mockResolvedValueOnce({ reachable: false, ok: false })
      .mockResolvedValueOnce({ reachable: false, ok: false })
      .mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      undefined,
      spawnImpl,
    );

    const [first, second] = await Promise.all([
      servers.ensureStarted('strata'),
      servers.ensureStarted('strata'),
    ]);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(spawnImpl).toHaveBeenCalledOnce();
  });

  it('ensureStarted allows a fresh start after the in-flight one fails', async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      const strata = config.models.find((model) => model.name === 'strata')!;
      strata.start_command = ['start-strata', 'hidden'];
      const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
      // Down forever: the first start times out, then a retry must be able to try.
      probeHttpMock.mockResolvedValue({ reachable: false, ok: false });
      const servers = new ExternalModelServers(
        () => config,
        async () => undefined,
        undefined,
        spawnImpl,
      );

      const first = servers.ensureStarted('strata');
      first.catch(() => {});
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + START_POLL_MS * 2);
      await expect(first).rejects.toThrow(/did not become reachable/);
      expect(spawnImpl).toHaveBeenCalledOnce();

      const second = servers.ensureStarted('strata');
      second.catch(() => {});
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + START_POLL_MS * 2);
      await expect(second).rejects.toThrow(/did not become reachable/);
      expect(spawnImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex review follow-up: joining must not mean only ONE caller learns the
  // start failed. Both join the same promise, so both see the same failure,
  // and the next request still gets a fresh attempt.
  it('ensureStarted gives every joined caller the failure, then retries once', async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      const strata = config.models.find((model) => model.name === 'strata')!;
      strata.start_command = ['start-strata', 'hidden'];
      const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
      probeHttpMock.mockResolvedValue({ reachable: false, ok: false });
      const servers = new ExternalModelServers(
        () => config,
        async () => undefined,
        undefined,
        spawnImpl,
      );

      const joined = Promise.allSettled([
        servers.ensureStarted('strata'),
        servers.ensureStarted('strata'),
        servers.ensureStarted('strata'),
      ]);
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + START_POLL_MS * 2);
      const outcomes = await joined;
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
      for (const outcome of outcomes) {
        expect((outcome as PromiseRejectedResult).reason.message).toMatch(
          /did not become reachable/,
        );
      }
      expect(spawnImpl).toHaveBeenCalledOnce();

      const retry = servers.ensureStarted('strata');
      retry.catch(() => {});
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + START_POLL_MS * 2);
      await expect(retry).rejects.toThrow(/did not become reachable/);
      expect(spawnImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ensureStarted throws an actionable error when down with no start_command', async () => {
    const config = makeConfig();
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    probeHttpMock.mockResolvedValue({ reachable: false, ok: false });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      undefined,
      spawnImpl,
    );
    await expect(servers.ensureStarted('strata')).rejects.toThrow(/not running/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('ensureStarted times out if the server never becomes reachable', async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      const strata = config.models.find((model) => model.name === 'strata')!;
      strata.start_command = ['start-strata', 'hidden'];
      const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
      probeHttpMock.mockResolvedValue({ reachable: false, ok: false });
      const servers = new ExternalModelServers(
        () => config,
        async () => undefined,
        undefined,
        spawnImpl,
      );
      const promise = servers.ensureStarted('strata');
      // Attach a no-op handler immediately so the rejection (fired by the fake
      // timers below) is never unhandled; the assertion still sees it.
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + START_POLL_MS * 2);
      await expect(promise).rejects.toThrow(/did not become reachable/);
      expect(spawnImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('deferred stop watcher', () => {
  // Runs the real watcher script; the "stop command" is node writing a marker.
  async function runWatcher(leasePid: number | undefined): Promise<boolean> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stop-'));
    const leaseDir = path.join(dir, 'leases');
    fs.mkdirSync(leaseDir);
    if (leasePid !== undefined) {
      fs.writeFileSync(path.join(leaseDir, 'a.json'), JSON.stringify({ pid: leasePid }));
    }
    const marker = path.join(dir, 'stopped');
    const stop = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
    ];
    const { command, args, env } = deferredStopInvocation(leaseDir, 50, stop);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { env, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    for (let i = 0; i < 30 && !fs.existsSync(marker); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stopped = fs.existsSync(marker);
    fs.rmSync(dir, { recursive: true, force: true });
    return stopped;
  }

  it('stops the server when no Forge window holds a lease', async () => {
    expect(await runWatcher(undefined)).toBe(true);
  }, 15_000);

  it('leaves the server running when a live window re-took a lease (reload)', async () => {
    expect(await runWatcher(process.pid)).toBe(false);
  }, 15_000);
});

describe('BackendPool with a managed external server', () => {
  beforeEach(() => {
    events.length = 0;
    // These tests exercise local-model freeing, not starting: keep the external
    // server "up" so prepareExternal's ensureStarted returns without spawning.
    probeHttpMock.mockResolvedValue({ reachable: true, ok: true });
  });

  it('stopAll and release reach the external server', async () => {
    const { servers, calls } = makeServers(ok);
    const pool = new BackendPool(makeConfig(), undefined, servers);
    await pool.stopAll();
    expect(calls).toHaveLength(1);
    servers.markInUse('strata');
    await pool.release('strata');
    expect(calls).toHaveLength(2);
    expect(pool.isLoaded('strata')).toBe(false);
  });

  it('reports a used external server ready and moves the signature with it', async () => {
    // The sidebar re-posts the selector only when this signature changes, so
    // Strata loading or unloading must move it or the dot never updates.
    const { servers } = makeServers(ok);
    const pool = new BackendPool(makeConfig(), undefined, servers);
    const before = pool.residencySignature();
    expect(pool.isModelReady('strata')).toBe(false);

    servers.markInUse('strata');
    expect(pool.isModelReady('strata')).toBe(true);
    const loaded = pool.residencySignature();
    expect(loaded).not.toBe(before);

    await pool.release('strata');
    expect(pool.isModelReady('strata')).toBe(false);
    expect(pool.residencySignature()).not.toBe(loaded);
  });

  it('unloads the external server before spawning a local model', async () => {
    const { servers } = makeServers(ok);
    const pool = new BackendPool(makeConfig(), undefined, servers);
    await pool.acquire('llama');
    expect(events).toEqual(['unload:strata', 'spawn:9100']);
    // Already unloaded: a second local spawn does not POST again.
    await pool.release('llama');
    await pool.acquire('llama');
    expect(events.filter((e) => e === 'unload:strata')).toHaveLength(1);
  });

  it('stops idle local models before a request to the external server', async () => {
    const { servers } = makeServers(ok);
    const pool = new BackendPool(makeConfig(), undefined, servers);
    await pool.acquire('llama');
    events.length = 0;
    await pool.prepareExternal('strata');
    expect(events).toEqual(['stop:9100']);
    expect(pool.isLoaded('llama')).toBe(false);
    expect(pool.isLoaded('strata')).toBe(true);
    expect(pool.loadedModelsExcept('llama')).toEqual(['strata']);
  });

  it('never stops a local model under a running turn', async () => {
    const stopLocal = vi.fn(async () => {});
    await expect(
      freeLocalForExternal('strata', { local: ['llama'], busy: () => true, stopLocal }),
    ).rejects.toThrow(/a turn is running on it/);
    expect(stopLocal).not.toHaveBeenCalled();
  });

  it('a request-resolved model keeps unload_path, so the hook fires', async () => {
    const hook = vi.fn(async () => {});
    setExternalRequestHook(hook);
    try {
      await beforeExternalRequest(resolveRequestModel(makeConfig(), 'strata'));
      await beforeExternalRequest(resolveRequestModel(makeConfig(), 'cloud'));
      expect(hook).toHaveBeenCalledTimes(1);
    } finally {
      setExternalRequestHook(undefined);
    }
  });

  it('frees local models before starting the external server (VRAM order)', async () => {
    const config = makeConfig();
    const strata = config.models.find((m) => m.name === 'strata')!;
    strata.start_command = ['start-strata', 'hidden'];
    // Mock the unload POST (acquire unloads the external server first) so no
    // real network call is made; record the start spawn into the shared events.
    const fetchImpl = (async () =>
      new Response('{"status":"unloaded"}', { status: 200 })) as unknown as typeof fetch;
    const spawnImpl = vi.fn(() => {
      events.push('ensureStarted:spawn');
      return { unref: vi.fn() };
    });
    // "is it up?" probe → down (so ensureStarted spawns); wait-loop probe → up.
    probeHttpMock
      .mockResolvedValueOnce({ reachable: false, ok: false })
      .mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl,
      spawnImpl,
    );
    const pool = new BackendPool(config, undefined, servers);
    await pool.acquire('llama');
    events.length = 0;
    await pool.prepareExternal('strata');
    // The local stop must precede the start spawn: Strata cannot load into VRAM
    // a local model still holds, so the order is load-bearing, not cosmetic.
    expect(events).toEqual(['stop:9100', 'ensureStarted:spawn']);
  });
});

describe('unload_path config', () => {
  const base = {
    active_model: 'm',
    llama_server: { binary: '/bin/llama-server' },
  };

  it('is accepted on openai-compatible and refused elsewhere', () => {
    const good = ForgeConfigSchema.safeParse({
      ...base,
      models: [
        {
          name: 'm',
          provider: 'openai-compatible',
          endpoint: 'http://127.0.0.1:8080',
          api_key_secret: 's',
          unload_path: '/unload',
        },
      ],
    });
    expect(good.success).toBe(true);
    const bad = ForgeConfigSchema.safeParse({
      ...base,
      models: [{ name: 'm', gguf_path: '/m.gguf', unload_path: '/unload' }],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('only for provider: openai-compatible');
  });

  it('requires stop_command and unload_path when stop_on_exit is true', () => {
    const model = {
      name: 'm',
      provider: 'openai-compatible' as const,
      endpoint: 'http://127.0.0.1:8080',
      api_key_secret: 's',
      stop_on_exit: true,
    };
    const missingBoth = ForgeConfigSchema.safeParse({ ...base, models: [model] });
    expect(missingBoth.success).toBe(false);
    expect(JSON.stringify(missingBoth.error?.issues)).toContain('stop_command is required');
    expect(JSON.stringify(missingBoth.error?.issues)).toContain('unload_path is required');

    const valid = ForgeConfigSchema.safeParse({
      ...base,
      models: [{ ...model, unload_path: '/unload', stop_command: ['cmd.exe', '/c', 'stop.bat'] }],
    });
    expect(valid.success).toBe(true);
  });
});

describe('start_command config', () => {
  const base = {
    active_model: 'm',
    llama_server: { binary: '/bin/llama-server' },
  };

  it('is accepted on openai-compatible with unload_path', () => {
    const good = ForgeConfigSchema.safeParse({
      ...base,
      models: [
        {
          name: 'm',
          provider: 'openai-compatible',
          endpoint: 'http://127.0.0.1:8080',
          api_key_secret: 's',
          unload_path: '/unload',
          start_command: ['cmd.exe', '/c', 'start.bat', 'hidden'],
        },
      ],
    });
    expect(good.success).toBe(true);
  });

  it('is refused on a non-openai-compatible provider', () => {
    const bad = ForgeConfigSchema.safeParse({
      ...base,
      models: [{ name: 'm', gguf_path: '/m.gguf', start_command: ['x'] }],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('only for provider: openai-compatible');
  });

  it('requires unload_path', () => {
    const bad = ForgeConfigSchema.safeParse({
      ...base,
      models: [
        {
          name: 'm',
          provider: 'openai-compatible',
          endpoint: 'http://127.0.0.1:8080',
          api_key_secret: 's',
          start_command: ['x'],
        },
      ],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('start_command requires unload_path');
  });
});
