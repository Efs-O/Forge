import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendPool } from '../../src/backend/BackendPool';
import {
  ExternalModelServers,
  beforeExternalRequest,
  setExternalRequestHook,
} from '../../src/backend/ExternalModelServers';
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
  });

  it('counts an unknown server as loaded, and an unload POST marks it unloaded', async () => {
    const { servers, calls } = makeServers(ok);
    expect(servers.isManaged('strata')).toBe(true);
    expect(servers.isManaged('cloud')).toBe(false);
    expect(servers.isLoaded('strata')).toBe(true);

    await servers.unload('strata');
    expect(calls[0].url).toBe('http://127.0.0.1:8080/unload');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer token-strata' });
    expect(servers.isLoaded('strata')).toBe(false);

    servers.markInUse('strata');
    expect(servers.isLoaded('strata')).toBe(true);
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
});

describe('BackendPool with a managed external server', () => {
  beforeEach(() => {
    events.length = 0;
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
});
