import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackendPool } from '../../src/backend/BackendPool';
import { deferredStopInvocation, STOP_GRACE_MS } from '../../src/backend/deferredStop';
import { freeVramForExternal, ExternalBusyError } from '../../src/backend/poolAcquisition';
import {
  ExternalModelServers,
  ExternalServerBusyError,
  beforeExternalRequest,
  setExternalRequestHook,
  START_TIMEOUT_MS,
  START_POLL_MS,
} from '../../src/backend/ExternalModelServers';
import { ModelStarterLeases } from '../../src/backend/ModelStarterLeases';
import {
  prepareExternalForRequest,
  type ExternalCoordinationContext,
} from '../../src/backend/BackendPoolExternal';
import { SharedRuntimeRegistry } from '../../src/backend/SharedRuntimeRegistry';
import { ForgeConfigSchema } from '../../src/config/schema';
import { resolveRequestModel } from '../../src/config/ConfigResolver';
import type { ForgeConfig } from '../../src/config/types';
import { type ProviderTurnContext } from '../../src/sidebar/ProviderTurn';
import { runCloudProviderTurn } from '../../src/sidebar/cloudProviderTurn';
import { logger } from '../../src/util/logger';

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

const probeHttpMock = vi.hoisted(() => vi.fn(async () => ({ reachable: false, ok: false })));
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

function twoManagedConfig(): ForgeConfig {
  return {
    models: ['iq2xs', 'iq3s'].map((name, index) => ({
      name,
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${8080 + index}`,
      unload_path: '/unload',
      start_command: ['node', 'server.js'],
    })),
    active_model: 'iq2xs',
    llama_server: { port: 9100 },
  } as ForgeConfig;
}

/**
 * Two managed entries on ONE endpoint, each naming the model it wants: the
 * `http://127.0.0.1:8090` shape that broke a chat on 2026-11-27. A Strata
 * launcher stays on its port after `/unload` (`auto_load: true`), so switching
 * entries used to return "already up" and the launcher answered every request
 * with the model that had been loaded before.
 */
function sharedEndpointConfig(): ForgeConfig {
  return {
    models: [
      {
        name: 'a',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8090',
        model: 'm-a',
        unload_path: '/unload',
        start_command: ['start-a'],
        stop_command: ['stop-a'],
      },
      {
        name: 'b',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8090',
        model: 'm-b',
        unload_path: '/unload',
        stop_command: ['stop-b'],
      },
    ],
    active_model: 'a',
    llama_server: { port: 9100 },
  } as ForgeConfig;
}

/** The endpoint's two residency reads: `null` for either body means 404 there. */
function sharedEndpointFetch(models: unknown, status: unknown): typeof fetch {
  return async (input) => {
    const pathname = new URL(String(input)).pathname;
    const body = pathname === '/v1/models' ? models : pathname === '/v1/status' ? status : null;
    return body === null
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  };
}

function makeServers(respond: () => Promise<Response>): {
  servers: ExternalModelServers;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const config = makeConfig();
  const modelId = config.models.find((model) => model.name === 'strata')?.model ?? 'strata-model';
  let resident = true;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const requestUrl = new URL(String(url));
    if (init.method === 'POST') {
      calls.push({ url: String(url), init });
      events.push('unload:strata');
      const response = await respond();
      if (response.ok) resident = false;
      return response;
    }
    if (requestUrl.pathname === '/v1/status') {
      return new Response(JSON.stringify({ service: 'strata', model: modelId, loaded: false }));
    }
    return new Response(
      JSON.stringify({
        data: [{ id: modelId, status: { value: resident ? 'loaded' : 'unloaded' } }],
      }),
    );
  }) as unknown as typeof fetch;
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

  it('publishes the residency-change token on a load and an unload, never on a probe', async () => {
    const { servers } = makeServers(ok);
    const bumps: string[] = [];
    servers.setResidencyChangeHook(() => bumps.push('b'));
    servers.markInUse('strata');
    await servers.unload('strata');
    // A window freeing GPUs re-reads residency outside the machine-wide lock and
    // trusts this token to tell it when that map went stale (BL-032). Only a change
    // this window MADE publishes: if a probe observation did, every window would
    // invalidate its own probe and the re-read would land back inside the lock.
    expect(bumps).toEqual(['b', 'b']);
    await servers.reconcileForFree(['strata']);
    await servers.refreshResidency();
    // Neither re-read published: a probe that merely caught up with the board
    // would otherwise invalidate every probe in flight, including its own window's.
    expect(bumps).toEqual(['b', 'b']);
  });

  it('frees the names it is given, not only the ones its map believes loaded', async () => {
    const { servers, calls } = makeServers(ok);
    await servers.unload('strata');
    expect(servers.loadedNames()).toEqual([]);
    calls.length = 0;
    // A caller that cannot prove its residency map current passes the names
    // (BL-032): `unloadAll` iterating an empty map would free nothing at all.
    await servers.unloadAll(true, ['strata']);
    expect(calls.map((call) => call.url)).toEqual(['http://127.0.0.1:8080/unload']);
  });

  it('refuses a real swap while another window holds the managed server for a turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-external-turn-'));
    try {
      const config = twoManagedConfig();
      const registryA = new SharedRuntimeRegistry(dir);
      const registryB = new SharedRuntimeRegistry(dir);
      const unloads: string[] = [];
      probeHttpMock.mockResolvedValue({ reachable: true, ok: true });
      const servers = new ExternalModelServers(
        () => config,
        async () => undefined,
        (async (url) => {
          unloads.push(String(url));
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
      );
      const firstWindow = new BackendPool(config, registryA, servers);
      const secondWindow = new BackendPool(config, registryB, servers);
      let refused = '';
      let unloadCountAtRefusal = -1;
      setExternalRequestHook((model) => firstWindow.prepareExternal(model.name));
      const turnContext = {
        pool: firstWindow,
        lifecycle: {
          clearStreaming: () => {},
          settle: () => {},
          markStreaming: () => {},
          incompleteReason: () => undefined,
        },
        checkpoints: { beginTurn: () => ({}), depth: () => 0, commitTurn: () => {} },
        events: {},
        emitAgentProgress: () => {},
        commitUserPrompt: () => {},
        runModelTurn: async () => {
          unloadCountAtRefusal = unloads.length;
          try {
            await secondWindow.prepareExternal('iq3s');
          } catch (error) {
            refused = error instanceof Error ? error.message : String(error);
          }
          return {
            finalText: 'done',
            finishReason: 'stop',
            rounds: 1,
            repeatedCall: false,
            hitRoundCap: false,
          };
        },
      } as unknown as ProviderTurnContext;
      try {
        await runCloudProviderTurn(turnContext, {
          conv: { id: 'chat-a', title: 'Build helper', updatedAt: Date.now() } as never,
          model: config.models[0]!,
          text: 'hello',
          attachments: undefined,
          activeFile: undefined,
          ctrl: new AbortController(),
          postC: () => {},
        });
      } finally {
        setExternalRequestHook(undefined);
      }
      expect(refused).toContain(
        "iq2xs is serving chat 'Build helper' right now. Loading iq3s would cut that turn off.",
      );
      expect(unloads).toHaveLength(unloadCountAtRefusal);

      await secondWindow.prepareExternal('iq3s');
      expect(unloads.length).toBeGreaterThan(unloadCountAtRefusal);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims external turn holds from dead windows and keeps one across a sleep', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-external-hold-expiry-'));
    try {
      const aliveRegistry = new SharedRuntimeRegistry(dir, () => true);
      const deadWindowRegistry = new SharedRuntimeRegistry(dir, () => false);
      const deadWindowHold = await aliveRegistry.acquireExternalTurnHold(
        'iq2xs',
        'dead',
        'Dead window',
        () => true,
      );
      expect(deadWindowRegistry.externalTurnHolders()).toEqual([]);
      deadWindowHold.release();

      let now = 1_000;
      const ttlRegistry = new SharedRuntimeRegistry(
        dir,
        () => true,
        () => now,
      );
      const asleep = await ttlRegistry.acquireExternalTurnHold(
        'iq2xs',
        'asleep',
        'Turn across a sleep',
        () => true,
      );
      // BL-021: a suspension longer than the TTL. The refresh is a
      // `setInterval`, which cannot fire while the machine is asleep, so an
      // expired record is not evidence that the turn ended — reclaiming it here
      // let another window unload the model the resumed turn is about to ask
      // for. A record whose process is alive now survives, and the cost is
      // bounded by that window's life: every turn path releases in its finally.
      now += 200_000;
      expect(ttlRegistry.externalTurnHolders().map((h) => h.conversationId)).toEqual(['asleep']);
      // A dead process is reclaimed however fresh its record looks, so a window
      // that went away during the sleep cannot keep protecting a model nobody
      // is using.
      const deadAfter = new SharedRuntimeRegistry(
        dir,
        () => false,
        () => now,
      );
      expect(deadAfter.externalTurnHolders()).toEqual([]);
      asleep.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('marks confirmed residency unloaded when the managed server refuses connections', async () => {
    const config = makeConfig();
    config.models[1].model = 'strata-model';
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    });
    const servers = new ExternalModelServers(
      () => config,
      async () => 'token',
      fetchImpl,
    );
    servers.markInUse('strata');

    await servers.refreshResidency();

    expect(servers.isConfirmedLoaded('strata')).toBe(false);
  });

  it('marks confirmed residency unloaded when /v1/models reports status unloaded', async () => {
    const config = makeConfig();
    config.models[1].model = 'strata-model';
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'strata-model', status: { value: 'unloaded' } }] }),
        ),
    );
    const servers = new ExternalModelServers(
      () => config,
      async () => 'token',
      fetchImpl,
    );
    servers.markInUse('strata');

    await servers.refreshResidency();

    expect(servers.isConfirmedLoaded('strata')).toBe(false);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8080/v1/models');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('keeps confirmed residency loaded when /v1/models reports loaded', async () => {
    const config = makeConfig();
    config.models[1].model = 'strata-model';
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'strata-model', status: { value: 'loaded' } }] }),
        ),
    );
    const servers = new ExternalModelServers(
      () => config,
      async () => 'token',
      fetchImpl,
    );
    servers.markInUse('strata');

    await servers.refreshResidency();

    expect(servers.isConfirmedLoaded('strata')).toBe(true);
  });

  it.each([
    [
      'a timeout',
      async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ],
    ['an HTTP 500 response', async () => new Response('{}', { status: 500 })],
    ['malformed JSON', async () => new Response('{', { status: 200 })],
  ])('leaves confirmed residency unchanged after %s', async (_outcome, respond) => {
    const config = makeConfig();
    config.models[1].model = 'strata-model';
    const fetchImpl = vi.fn<typeof fetch>(respond);
    const servers = new ExternalModelServers(
      () => config,
      async () => 'token',
      fetchImpl,
    );
    servers.markInUse('strata');

    await servers.refreshResidency();

    expect(servers.isConfirmedLoaded('strata')).toBe(true);
  });

  it('keeps residency loaded when a request arrives while the probe is pending', async () => {
    const config = makeConfig();
    config.models[1].model = 'strata-model';
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(() => response);
    const servers = new ExternalModelServers(
      () => config,
      async () => 'token',
      fetchImpl,
    );
    servers.markInUse('strata');

    const refresh = servers.refreshResidency();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    servers.markInUse('strata');
    resolveResponse?.(
      new Response(
        JSON.stringify({ data: [{ id: 'strata-model', status: { value: 'unloaded' } }] }),
      ),
    );
    await refresh;

    expect(servers.isConfirmedLoaded('strata')).toBe(true);
  });

  it('probes unknown and unloaded managed servers during selector refresh', async () => {
    const config = makeConfig();
    config.models[1].model = 'strata-model';
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'strata-model', status: { value: 'unloaded' } }] }),
        ),
    );
    const servers = new ExternalModelServers(
      () => config,
      async () => 'token',
      fetchImpl,
    );

    await servers.refreshResidency();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(servers.isConfirmedLoaded('strata')).toBe(false);

    servers.markInUse('strata');
    await servers.unload('strata');
    const callsAfterUnload = fetchImpl.mock.calls.length;
    await servers.refreshResidency();
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterUnload + 2);
  });

  it('single-flights concurrent residency refreshes once per loaded managed model', async () => {
    const config = makeConfig();
    config.models[1].model = 'strata-model';
    config.models.push({
      name: 'maya',
      provider: 'openai-compatible',
      model: 'maya-model',
      endpoint: 'http://127.0.0.1:8081',
      unload_path: '/unload',
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl,
    );
    servers.markInUse('strata');
    servers.markInUse('maya');

    const first = servers.refreshResidency();
    const second = servers.refreshResidency();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps prior residency when a probe fails unexpectedly', async () => {
    const config = makeConfig();
    config.models[1].model = 'strata-model';
    config.models.push({
      name: 'maya',
      provider: 'openai-compatible',
      model: 'maya-model',
      endpoint: 'http://127.0.0.1:8081',
      unload_path: '/unload',
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('unexpected fetch failure');
    });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl,
    );
    servers.markInUse('strata');
    servers.markInUse('maya');
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => {});

    try {
      await expect(servers.refreshResidency()).resolves.toBeUndefined();
      expect(logError).not.toHaveBeenCalled();
      expect(servers.isConfirmedLoaded('strata')).toBe(true);
    } finally {
      logError.mockRestore();
    }
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

  it('ensureStarted fails on a start command that cannot run, not at the timeout (U04-06)', async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      const strata = config.models.find((model) => model.name === 'strata')!;
      strata.start_command = ['no-such-start-strata'];
      const spawnImpl = vi.fn(() => ({
        unref: vi.fn(),
        once: (_event: 'error', listener: (error: Error) => void) =>
          setTimeout(() => listener(new Error('spawn no-such-start-strata ENOENT')), 0),
      }));
      probeHttpMock.mockResolvedValue({ reachable: false, ok: false });
      const servers = new ExternalModelServers(
        () => config,
        async () => undefined,
        undefined,
        spawnImpl,
      );

      const start = servers.ensureStarted('strata');
      start.catch(() => {});
      await vi.advanceTimersByTimeAsync(START_POLL_MS * 2);
      await expect(start).rejects.toThrow(
        'Start command for "strata" failed: spawn no-such-start-strata ENOENT',
      );
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
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
      ]);
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

  // The 2026-11-27 8090 incident: `strata-flashnext-unsloth-iq3xxs` and
  // `strata-flashnext-unsloth-iq2xs` shared one endpoint, and after a chat
  // switched to the IQ2 entry all 103 requests of the next two hours were
  // answered by the IQ3_XXS server — its engine never started, and its log file
  // was never created. A reachable port is not proof it is OUR port.
  it('ensureStarted stops the entry that holds a shared port before starting this one', async () => {
    const config = sharedEndpointConfig();
    const order: string[] = [];
    const spawnImpl = vi.fn((command: string) => {
      order.push(command);
      return { unref: vi.fn() };
    });
    // 8090 answers until b's stop command takes it away, then a's start brings it back.
    probeHttpMock
      .mockResolvedValueOnce({ reachable: true, ok: true })
      .mockResolvedValueOnce({ reachable: false, ok: false })
      .mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      sharedEndpointFetch({ data: [{ id: 'm-b', status: { value: 'loaded' } }] }, null),
      spawnImpl,
    );
    servers.markInUse('b');

    await servers.ensureStarted('a');

    // The order is the whole fix: stopping b must precede starting a, or a's
    // launcher races b's server for the same port.
    expect(order).toEqual(['stop-b', 'start-a']);
    expect(spawnImpl).toHaveBeenNthCalledWith(1, 'stop-b', [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    expect(spawnImpl).toHaveBeenNthCalledWith(2, 'start-a', [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    // The entry that gave up the port is no longer resident in this window's map.
    expect(servers.isLoaded('b')).toBe(false);
  });

  it('ensureStarted refuses a shared port that no model entry can stop', async () => {
    const config = sharedEndpointConfig();
    // Nothing claims the id on the port, so Forge has no command that could free it.
    config.models[1]!.model = 'old-hand-started-model';
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    probeHttpMock.mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      sharedEndpointFetch({ data: [{ id: 'm-b', status: { value: 'loaded' } }] }, null),
      spawnImpl,
    );

    const message = await servers.ensureStarted('a').then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );

    expect(message).toBe(
      '"a" needs http://127.0.0.1:8090, but the server there is serving "m-b", ' +
        'and no model entry on that endpoint can stop it. Stop that server, then retry.',
    );
    // Nothing was stopped and nothing was started: the owner's server is left
    // for the user to deal with, rather than answering with the wrong model.
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('ensureStarted leaves a shared port alone when it already serves this model', async () => {
    const config = sharedEndpointConfig();
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    probeHttpMock.mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      sharedEndpointFetch(
        {
          data: [
            { id: 'm-a', status: { value: 'loaded' } },
            { id: 'm-b', status: { value: 'unloaded' } },
          ],
        },
        null,
      ),
      spawnImpl,
    );

    await servers.ensureStarted('a');

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('ensureStarted still trusts a port that cannot say which model it serves', async () => {
    const config = sharedEndpointConfig();
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    probeHttpMock.mockResolvedValue({ reachable: true, ok: true });
    // llama-server's /v1/models carries no per-model `status`, and there is no
    // /v1/status to fall back to: "cannot tell" must keep working as it did.
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      sharedEndpointFetch({ data: [{ id: 'm-b', object: 'model' }] }, null),
      spawnImpl,
    );

    await servers.ensureStarted('a');

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('ensureStarted asks no residency question at all when nothing answers the port', async () => {
    const config = sharedEndpointConfig();
    const requests: string[] = [];
    const fetchImpl = (async (input: string) => {
      requests.push(new URL(String(input)).pathname);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    // Down for the "is it up?" probe, then a's start brings it back.
    probeHttpMock
      .mockResolvedValueOnce({ reachable: false, ok: false })
      .mockResolvedValue({ reachable: true, ok: true });
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl,
      spawnImpl,
    );

    await servers.ensureStarted('a');

    expect(spawnImpl).toHaveBeenCalledWith('start-a', [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    // A free port is ours without asking who was there.
    expect(requests).toEqual([]);
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
    if (leasePid === undefined) {
      for (let i = 0; i < 30 && !fs.existsSync(marker); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
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
  // A pool built without a registry falls back to this machine's shared
  // "which model is loaded and whose turn holds it" board, and a real chat
  // streaming on a managed model then refuses the very swap these tests ask
  // for — the outcome depended on what the owner happened to be doing. Each
  // test gets its own board in a temp folder instead.
  let boardDir: string | undefined;
  beforeEach(() => {
    events.length = 0;
    // These tests exercise local-model freeing, not starting: keep the external
    // server "up" so prepareExternal's ensureStarted returns without spawning.
    probeHttpMock.mockResolvedValue({ reachable: true, ok: true });
    boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-external-pool-'));
  });
  afterEach(() => {
    // The folder leaves with the test; nothing here outlives it.
    if (boardDir) fs.rmSync(boardDir, { recursive: true, force: true });
  });

  /**
   * A turn hold belonging to ANOTHER window. `acquireExternalTurnHold` always
   * records this process's pid, so the cross-window case has to be written into
   * the board by hand, on a registry that reports the foreign pid alive.
   */
  function heldByOtherWindow(model: string, title: string): SharedRuntimeRegistry {
    const registry = new SharedRuntimeRegistry(boardDir!, () => true);
    const id = '999999-other-window';
    const dir = path.join(boardDir!, 'external-turn-holds');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        model,
        pid: 999999,
        conversationId: 'other-window-chat',
        title,
        expiresAt: Date.now() + 60_000,
      }),
    );
    return registry;
  }

  it('stopAll and release reach the external server', async () => {
    const { servers, calls } = makeServers(ok);
    const pool = new BackendPool(makeConfig(), new SharedRuntimeRegistry(boardDir!), servers);
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
    const pool = new BackendPool(makeConfig(), new SharedRuntimeRegistry(boardDir!), servers);
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
    const registry = new SharedRuntimeRegistry(boardDir!);
    // The production wiring: the servers publish the machine-wide residency change
    // token the pool consults before trusting its map (BL-032). Without a hook the
    // pool can never prove its map current and frees conservatively, which is the
    // safe side but re-POSTs here.
    servers.setResidencyChangeHook(() => registry.bumpExternalResidencyGeneration());
    const pool = new BackendPool(makeConfig(), registry, servers);
    await pool.acquire('llama');
    expect(events).toEqual(['unload:strata', 'spawn:9100']);
    // Already unloaded: a second local spawn does not POST again.
    await pool.release('llama');
    await pool.acquire('llama');
    expect(events.filter((e) => e === 'unload:strata')).toHaveLength(1);
  });

  // BL-023 (bug hunt 2026-10-31): the local-spawn path POSTed these unloads
  // with no reference to the turn holds, so loading a GGUF model in one window
  // cut off another window's chat between its requests — when the managed
  // server is idle, its own 409 cannot protect a turn.
  it('refuses to spawn a local model while another window holds the managed server', async () => {
    const { servers, calls } = makeServers(ok);
    const pool = new BackendPool(
      makeConfig(),
      heldByOtherWindow('strata', 'Other window chat'),
      servers,
    );

    await expect(pool.acquire('llama')).rejects.toThrow(
      /Loading llama needs the GPUs strata is using for chat 'Other window chat'/,
    );
    // Nothing was freed, so the other window's model is still resident.
    expect(calls).toHaveLength(0);
    expect(events).toEqual([]);
    expect(pool.isLoaded('strata')).toBe(true);
  });

  it('refuses to release a managed server another window is serving a turn on', async () => {
    const { servers, calls } = makeServers(ok);
    const pool = new BackendPool(
      makeConfig(),
      heldByOtherWindow('strata', 'Other window chat'),
      servers,
    );
    servers.markInUse('strata');

    await expect(pool.release('strata')).rejects.toThrow(
      /Unloading strata would cut off chat 'Other window chat' in another window/,
    );
    expect(calls).toHaveLength(0);
    expect(pool.isLoaded('strata')).toBe(true);
  });

  // Codex's defect on the first BL-020 shape: both gates asked about residency,
  // and a claim for a model that is still STARTING is not in `loadedNames()`
  // yet, so a local load could bypass the check and compete for the VRAM.
  it('refuses a local spawn while another window is starting a model it has not loaded yet', async () => {
    const { servers, calls } = makeServers(ok);
    const pool = new BackendPool(
      makeConfig(),
      heldByOtherWindow('strata', 'Starting elsewhere'),
      servers,
    );
    await servers.unload('strata'); // residency unloaded: loadedNames() is empty
    expect(servers.loadedNames()).toEqual([]);

    await expect(pool.acquire('llama')).rejects.toThrow(
      /Loading llama needs the GPUs strata is using for chat 'Starting elsewhere'/,
    );
    // Nothing was spawned, and no extra unload was POSTed past the one above.
    expect(events.filter((event) => event === 'spawn:9100')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  // Codex's second reject: the "nothing resident, nobody holding" test cannot
  // be done outside the lock, because the window that holds the lock has not
  // published its claim yet — so a local load must wait for that decision
  // rather than answer from its own view of the board.
  it('waits for the machine-wide lock before deciding, even with nothing resident', async () => {
    const { servers } = makeServers(ok);
    const registry = new SharedRuntimeRegistry(boardDir!);
    const pool = new BackendPool(makeConfig(), registry, servers);
    await servers.unload('strata'); // nothing resident, no holds

    let releaseLock: () => void = () => {};
    const held = registry.withExternalTurnHoldLock(
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve;
        }),
    );
    await expect(pool.acquire('llama')).rejects.toThrow(
      /Timed out waiting for managed-server turn holds/,
    );
    expect(events.filter((event) => event === 'spawn:9100')).toEqual([]);
    releaseLock();
    await held;
  }, 15_000);

  it('still unloads for an explicit stopAll while another window holds it', async () => {
    // The owner's command may cut a held model off — the alternative is a model
    // no window can free — but `noteExternalsHeldElsewhere` names the chat.
    const { servers, calls } = makeServers(ok);
    const pool = new BackendPool(
      makeConfig(),
      heldByOtherWindow('strata', 'Other window chat'),
      servers,
    );
    await pool.stopAll();
    expect(calls).toHaveLength(1);
  });

  // BL-020 (bug hunt 2026-10-31): `ensureStarted` used to sit inside the
  // machine-wide lock. A cold start is up to START_TIMEOUT_MS of polling, and
  // that lock is the only thing another window's first managed turn waits on,
  // so the other turn failed after its 5 s wait with a message naming nothing.
  it('starts the server with the lock free, and claims the model while it comes up', async () => {
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-external-start-lock-'));
    try {
      const registry = new SharedRuntimeRegistry(board);
      let finishStart: () => void = () => {};
      const order: string[] = [];
      const external = {
        isManaged: () => true,
        managedNames: () => ['strata'],
        reconcileForFree: async () => {},
        residencyPublicationTrusted: () => true,
        loadedNames: () => ['strata'],
        unload: async () => {},
        ensureStarted: async () => {
          order.push('ensureStarted');
          await new Promise<void>((resolve) => {
            finishStart = resolve;
          });
          order.push('reachable');
        },
        markInUse: () => order.push('markInUse'),
      } as unknown as ExternalModelServers;
      const ctx: ExternalCoordinationContext = {
        external,
        slots: new Map(),
        ollamaSlots: new Map(),
        sharedSlots: new Map(),
        registry,
        sharedRuntimeEnabled: false,
        runtimeKey: () => 'k',
        freeSlot: () => {},
        isBusy: () => false,
        isDelegationPinned: () => false,
        isOllamaModel: () => false,
      };

      const request = prepareExternalForRequest('strata', ctx);
      // Let the claim land, then measure while the start is still pending.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const got = await Promise.race([
        registry.withExternalTurnHoldLock(async () => 'lock'),
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 400)),
      ]);
      expect(got).toBe('lock');
      // The model is claimed for this load, so another window cannot take the
      // GPUs it is coming up on, even though the lock is free.
      expect(registry.externalTurnHolders().map((hold) => hold.model)).toEqual(['strata']);

      finishStart();
      await request;
      expect(order).toEqual(['ensureStarted', 'reachable', 'markInUse']);
      // The claim leaves with the request, whether it succeeded or not.
      expect(registry.externalTurnHolders()).toEqual([]);
    } finally {
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('releases the claim when the start fails', async () => {
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-external-start-fail-'));
    try {
      const registry = new SharedRuntimeRegistry(board);
      const external = {
        isManaged: () => true,
        managedNames: () => ['strata'],
        reconcileForFree: async () => {},
        residencyPublicationTrusted: () => true,
        loadedNames: () => ['strata'],
        unload: async () => {},
        ensureStarted: async () => {
          throw new Error('nothing is listening at http://127.0.0.1:8080');
        },
        markInUse: () => {},
      } as unknown as ExternalModelServers;
      const ctx: ExternalCoordinationContext = {
        external,
        slots: new Map(),
        ollamaSlots: new Map(),
        sharedSlots: new Map(),
        registry,
        sharedRuntimeEnabled: false,
        runtimeKey: () => 'k',
        freeSlot: () => {},
        isBusy: () => false,
        isDelegationPinned: () => false,
        isOllamaModel: () => false,
      };

      await expect(prepareExternalForRequest('strata', ctx)).rejects.toThrow(
        /nothing is listening/,
      );
      // A failed start must not leave the claim behind: it would keep every
      // other window off the GPUs until this window closes, because a hold whose
      // process is alive is no longer reclaimed on expiry.
      expect(registry.externalTurnHolders()).toEqual([]);
    } finally {
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('stops idle local models before a request to the external server', async () => {
    const { servers } = makeServers(ok);
    const pool = new BackendPool(makeConfig(), new SharedRuntimeRegistry(boardDir!), servers);
    await pool.acquire('llama');
    events.length = 0;
    await pool.prepareExternal('strata');
    expect(events).toEqual(['stop:9100']);
    expect(pool.isLoaded('llama')).toBe(false);
    expect(pool.isLoaded('strata')).toBe(true);
    expect(pool.loadedModelsExcept('llama')).toEqual(['strata']);
  });

  it('never stops a local model or unloads another server under a running turn', async () => {
    const stopLocal = vi.fn(async () => {});
    const unloadExternal = vi.fn(async () => {});
    const free = (local: string[], otherExternal: string[]) =>
      freeVramForExternal('strata', {
        local,
        otherExternal,
        busy: () => true,
        stopLocal,
        unloadExternal,
      });
    await expect(free(['llama'], [])).rejects.toThrow(/a turn is running on it/);
    await expect(free([], ['strata-xxs'])).rejects.toThrow(/beside strata-xxs: a turn/);
    expect(stopLocal).not.toHaveBeenCalled();
    expect(unloadExternal).not.toHaveBeenCalled();
  });

  it('unloads another managed server before a request to this one (shared GPUs)', async () => {
    const config = makeConfig();
    config.models.push({
      name: 'strata-xxs',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8091',
      api_key_secret: 'strata',
      unload_path: '/unload',
    } as ForgeConfig['models'][number]);
    const urls: string[] = [];
    let resident = true;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (init?.method === 'POST') {
        urls.push(input);
        resident = false;
        return ok();
      }
      if (url.pathname === '/v1/status') {
        return new Response(
          JSON.stringify({ service: 'strata', model: 'strata-model', loaded: false }),
        );
      }
      return new Response(
        JSON.stringify({
          data: [{ id: 'strata-model', status: { value: resident ? 'loaded' : 'unloaded' } }],
        }),
      );
    }) as unknown as typeof fetch;
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl,
    );
    const registry = new SharedRuntimeRegistry(boardDir!);
    // Production wiring: the servers publish the machine-wide residency change token
    // the pool consults before trusting its map (BL-032). Unwired, the pool can
    // never prove its map current and re-POSTs each request — safe, but this test
    // pins the opposite optimisation.
    servers.setResidencyChangeHook(() => registry.bumpExternalResidencyGeneration());
    const pool = new BackendPool(config, registry, servers);
    servers.markInUse('strata');
    await pool.prepareExternal('strata-xxs');
    expect(urls).toEqual(['http://127.0.0.1:8080/unload']);
    expect(pool.isLoaded('strata')).toBe(false);
    expect(pool.isLoaded('strata-xxs')).toBe(true);
    // Already unloaded: the next request does not POST again.
    await pool.prepareExternal('strata-xxs');
    expect(urls).toHaveLength(1);
  });

  it('refuses to start beside a managed server that is busy for another window', async () => {
    const config = makeConfig();
    config.models.push({
      name: 'strata-xxs',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8091',
      unload_path: '/unload',
    } as ForgeConfig['models'][number]);
    const fetchImpl = (async () =>
      new Response('busy', { status: 409 })) as unknown as typeof fetch;
    const spawnImpl = vi.fn();
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl,
      spawnImpl,
    );
    const pool = new BackendPool(config, new SharedRuntimeRegistry(boardDir!), servers);
    servers.markInUse('strata');
    await expect(pool.prepareExternal('strata-xxs')).rejects.toThrow(
      /Could not unload "strata": HTTP 409/,
    );
    expect(pool.isModelReady('strata-xxs')).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
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
    const pool = new BackendPool(config, new SharedRuntimeRegistry(boardDir!), servers);
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

/**
 * `stopOnExit` and a remote lease (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md
 * problem 2). A lease is NOT a desktop turn: it lives in the pool's pin counter
 * and in `ModelStarterLeases`, so the busy check `extension.ts` passes here has
 * to OR in `hasLease` — otherwise closing the last desktop window unloads and
 * stops the very server a laptop turn is running on, and the laptop's turn dies
 * mid-generation with nothing at the desktop to fix it.
 */
describe('ExternalModelServers stopOnExit and remote leases', () => {
  beforeEach(() => {
    events.length = 0;
    probeHttpMock.mockReset();
  });

  it('skips a leased model and launches no watcher, stops it once the lease is gone', async () => {
    const config = makeConfig();
    const strata = config.models.find((model) => model.name === 'strata')!;
    strata.stop_on_exit = true;
    strata.stop_command = ['stop-strata'];
    const fetchImpl = vi.fn(async () => new Response('{"status":"unloaded"}', { status: 200 }));
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      fetchImpl as unknown as typeof fetch,
      spawnImpl,
    );
    let clock = 1_700_000_000_000;
    const leases = new ModelStarterLeases(
      () => 600_000,
      () => clock,
    );
    const pool = new BackendPool(config, new SharedRuntimeRegistry(), servers, leases);
    // What a laptop `POST /ensure` does to this window's pool: one pin, held by
    // a lease, with no desktop turn anywhere near it.
    const lease = leases.grant({
      client: 'laptop-1',
      model: 'strata',
      port: 8080,
      kind: 'managed-external',
      release: pool.pinModel('strata'),
    });
    expect(lease.model).toBe('strata');
    // The exact composition extension.ts uses for `stopOnExit`'s isBusy.
    const desktopTurns: string[] = [];
    const isBusy = (modelName: string) =>
      desktopTurns.includes(modelName) || leases.hasLease(modelName);
    expect(desktopTurns).toEqual([]);
    expect(isBusy('strata')).toBe(true);

    await servers.stopOnExit({ lastWindow: true, isBusy, leaseDir: 'leases' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();

    // The laptop stopped renewing (its window closed): the lease lapsed, so the
    // last-window exit behaves exactly as it did before the starter existed.
    clock += 600_001;
    leases.expireNow();
    expect(isBusy('strata')).toBe(false);
    await servers.stopOnExit({ lastWindow: true, isBusy, leaseDir: 'leases' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(spawnImpl).toHaveBeenCalledOnce();
    // The pin is gone with the lease, so the pool no longer calls it busy.
    expect(pool.isBusy('strata')).toBe(false);
  });

  it('names the blocking model whichever way the refusal arrived', async () => {
    const idle = { busy: () => false, local: [], otherExternal: [], stopLocal: async () => {} };
    let caught: unknown;
    try {
      await freeVramForExternal('maya', {
        ...idle,
        otherExternal: ['strata'],
        unloadExternal: () =>
          Promise.reject(new ExternalServerBusyError('Could not unload "strata": HTTP 409')),
      });
    } catch (error) {
      caught = error;
    }
    // The server's own 409 is turned into the same typed refusal, with the name
    // the message would have had to be read out of.
    expect(caught).toBeInstanceOf(ExternalBusyError);
    expect((caught as ExternalBusyError).busyModels).toEqual(['strata']);

    caught = undefined;
    try {
      await freeVramForExternal('maya', {
        local: ['gemma'],
        otherExternal: [],
        busy: (model) => model === 'gemma',
        stopLocal: async () => {},
        unloadExternal: async () => {},
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ExternalBusyError).busyModels).toEqual(['gemma']);
    expect((caught as ExternalBusyError).message).toMatch(/a turn is running on it/);
  });
});
