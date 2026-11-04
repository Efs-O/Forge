import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackendPool } from '../../src/backend/BackendPool';
import { ExternalBusyError } from '../../src/backend/poolAcquisition';
import {
  prepareExternalForRequest,
  type ExternalCoordinationContext,
} from '../../src/backend/BackendPoolExternal';
import { probeExternalModelResidency } from '../../src/backend/ExternalModelResidencyProbe';
import { ExternalModelServers } from '../../src/backend/ExternalModelServers';
import { SharedRuntimeRegistry } from '../../src/backend/SharedRuntimeRegistry';
import type { ForgeConfig } from '../../src/config/types';

const probeHttpMock = vi.hoisted(() => vi.fn(async () => ({ reachable: true, ok: true })));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    createOutputChannel: () => ({ appendLine: () => {}, clear: () => {}, show: () => {} }),
  },
}));

vi.mock('../../src/backend/HealthCheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/backend/HealthCheck')>();
  return { ...actual, probeHttp: probeHttpMock };
});

interface FakeModelState {
  value: 'loaded' | 'unloaded';
}

interface MutableServerState {
  models: unknown;
  status: unknown;
  unloadStatus?: number;
  failure?: 'timeout' | 'connection-refused';
  unloads: number;
}

function config(xGpus: readonly number[] = [0]): ForgeConfig {
  return {
    active_model: 'y',
    llama_server: { port: 9100 },
    models: [
      {
        name: 'x',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8090',
        model: 'model-x',
        unload_path: '/unload',
        gpus: [...xGpus],
      },
      {
        name: 'y',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8091',
        model: 'model-y',
        unload_path: '/unload',
        gpus: [0],
      },
    ],
  } as ForgeConfig;
}

function makeServerState(modelId = 'model-x'): MutableServerState {
  return {
    models: { data: [{ id: modelId, status: { value: 'loaded' } }] },
    status: { service: 'strata', model: modelId, loaded: false },
    unloads: 0,
  };
}

function makeUnloadedServerState(modelId: string): MutableServerState {
  const state = makeServerState(modelId);
  state.models = { data: [{ id: modelId, status: { value: 'unloaded' } }] };
  return state;
}

function makeFetch(
  servers: ReadonlyMap<string, MutableServerState>,
  requests: string[],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.origin}${url.pathname}`);
    const state = servers.get(url.origin);
    if (!state) return new Response('{}', { status: 404 });

    if (method === 'POST' && url.pathname === '/unload') {
      state.unloads += 1;
      if (state.unloadStatus === 409) return new Response('busy', { status: 409 });
      state.models = { data: [] };
      state.status = { service: 'strata', model: 'model-x', loaded: false };
      return new Response('{}', { status: 200 });
    }
    if (url.pathname === '/v1/models' && state.failure === 'timeout') {
      throw new DOMException('timed out', 'TimeoutError');
    }
    if (url.pathname === '/v1/models' && state.failure === 'connection-refused') {
      const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      throw Object.assign(new TypeError('fetch failed'), { cause });
    }
    if (url.pathname === '/v1/models') {
      return new Response(JSON.stringify(state.models), { status: 200 });
    }
    if (url.pathname === '/v1/status') {
      return new Response(JSON.stringify(state.status), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

function makeContext(
  external: ExternalModelServers,
  registry: SharedRuntimeRegistry,
  isBusy: (model: string) => boolean = () => false,
): ExternalCoordinationContext {
  return {
    external,
    slots: new Map(),
    ollamaSlots: new Map(),
    sharedSlots: new Map(),
    registry,
    sharedRuntimeEnabled: false,
    runtimeKey: () => 'unused',
    freeSlot: () => {},
    isBusy,
    isDelegationPinned: () => false,
    isOllamaModel: () => false,
  };
}

describe('external residency reconciliation', () => {
  it('re-reads another window’s loaded model before freeing overlapping GPUs', async () => {
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-residency-unit-'));
    const models = config();
    const state: FakeModelState = { value: 'unloaded' };
    const unloads: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/models') {
        return new Response(
          JSON.stringify({ data: [{ id: 'model-x', status: { value: state.value } }] }),
        );
      }
      if (url.pathname === '/unload' && init?.method === 'POST') {
        unloads.push(url.origin);
        state.value = 'unloaded';
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    try {
      const windowA = new ExternalModelServers(
        () => models,
        async () => undefined,
        fetchImpl,
      );
      const windowB = new ExternalModelServers(
        () => models,
        async () => undefined,
        fetchImpl,
      );
      const poolA = new BackendPool(models, new SharedRuntimeRegistry(board), windowA);

      await windowA.unload('x');
      expect(windowA.loadedNames()).not.toContain('x');
      unloads.length = 0;

      state.value = 'loaded';
      windowB.markInUse('x');
      await poolA.prepareExternal('y');

      expect(unloads).toEqual(['http://127.0.0.1:8090']);
      expect(windowA.isConfirmedLoaded('y')).toBe(true);
    } finally {
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('does not probe a configured server on GPUs that do not overlap the request', async () => {
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-residency-nonoverlap-'));
    const models = config([1]);
    const state = makeServerState();
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(new Map([['http://127.0.0.1:8090', state]]), requests),
    );

    try {
      await external.unload('x');
      state.models = { data: [{ id: 'model-x', status: { value: 'loaded' } }] };
      state.unloads = 0;
      requests.length = 0;

      await prepareExternalForRequest('y', makeContext(external, new SharedRuntimeRegistry(board)));

      expect(requests).toEqual([]);
      expect(state.unloads).toBe(0);
    } finally {
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('frees a hand-started model on a configured endpoint even when its id differs', async () => {
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-residency-hand-started-'));
    const models = config();
    const state = makeServerState('hand-started-model');
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(new Map([['http://127.0.0.1:8090', state]]), requests),
    );

    try {
      await external.unload('x');
      state.models = {
        data: [{ id: 'hand-started-model', status: { value: 'loaded' } }],
      };
      state.unloads = 0;
      requests.length = 0;

      await prepareExternalForRequest('y', makeContext(external, new SharedRuntimeRegistry(board)));

      expect(state.unloads).toBe(1);
      expect(requests).toContain('POST http://127.0.0.1:8090/unload');
    } finally {
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('frees a stale Strata claim and keeps it out of the selector', async () => {
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-residency-stale-claim-'));
    const models = config();
    const state = makeServerState();
    state.models = { data: [] };
    state.status = { service: 'strata', model: 'deepseek-v4.1-flash', loaded: true };
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(new Map([['http://127.0.0.1:8090', state]]), requests),
    );

    try {
      await external.unload('x');
      state.models = { data: [] };
      state.status = { service: 'strata', model: 'deepseek-v4.1-flash', loaded: true };
      state.unloads = 0;
      requests.length = 0;

      await prepareExternalForRequest('y', makeContext(external, new SharedRuntimeRegistry(board)));

      expect(requests).toEqual([
        'GET http://127.0.0.1:8090/v1/models',
        'GET http://127.0.0.1:8090/v1/status',
        'POST http://127.0.0.1:8090/unload',
      ]);
      expect(state.unloads).toBe(1);
      await external.refreshResidency();
      expect(external.isConfirmedLoaded('x')).toBe(false);
    } finally {
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('reports a loaded server 409 as ExternalBusyError and does not start the request model', async () => {
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-residency-409-'));
    const models = config();
    const state = makeServerState();
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(new Map([['http://127.0.0.1:8090', state]]), requests),
    );
    const ensureStarted = vi.spyOn(external, 'ensureStarted');

    try {
      await external.unload('x');
      state.models = { data: [{ id: 'model-x', status: { value: 'loaded' } }] };
      state.unloadStatus = 409;
      state.unloads = 0;
      requests.length = 0;

      let error: unknown;
      try {
        await prepareExternalForRequest(
          'y',
          makeContext(external, new SharedRuntimeRegistry(board)),
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ExternalBusyError);
      expect((error as ExternalBusyError).busyModels).toEqual(['x']);
      expect(ensureStarted).not.toHaveBeenCalled();
      expect(requests.at(-1)).toBe('POST http://127.0.0.1:8090/unload');
    } finally {
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('does not unload a reconciled server that has a same-window turn hold', async () => {
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-residency-same-window-busy-'));
    const models = config();
    const state = makeServerState();
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(new Map([['http://127.0.0.1:8090', state]]), requests),
    );
    const ensureStarted = vi.spyOn(external, 'ensureStarted');

    try {
      await external.unload('x');
      state.models = { data: [{ id: 'model-x', status: { value: 'loaded' } }] };
      state.unloads = 0;
      requests.length = 0;

      await expect(
        prepareExternalForRequest(
          'y',
          makeContext(external, new SharedRuntimeRegistry(board), (name) => name === 'x'),
        ),
      ).rejects.toBeInstanceOf(ExternalBusyError);
      expect(state.unloads).toBe(0);
      expect(requests).toEqual(['GET http://127.0.0.1:8090/v1/models']);
      expect(ensureStarted).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('reconciles every managed endpoint before unloadAll chooses its list', async () => {
    const models = config();
    const state = makeServerState();
    const other = makeUnloadedServerState('model-y');
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(
        new Map([
          ['http://127.0.0.1:8090', state],
          ['http://127.0.0.1:8091', other],
        ]),
        requests,
      ),
    );
    const windowB = new ExternalModelServers(
      () => models,
      async () => undefined,
    );

    await external.unload('x');
    state.models = { data: [{ id: 'model-x', status: { value: 'loaded' } }] };
    windowB.markInUse('x');
    state.unloads = 0;
    requests.length = 0;

    await external.unloadAll();

    expect(state.unloads).toBe(1);
    expect(other.unloads).toBe(0);
    expect(requests).toContain('GET http://127.0.0.1:8090/v1/models');
    expect(requests).toContain('GET http://127.0.0.1:8091/v1/models');
    expect(requests).toContain('POST http://127.0.0.1:8090/unload');
    expect(requests).not.toContain('POST http://127.0.0.1:8091/unload');
  });

  it.each([
    ['a timeout', 'timeout', 1],
    ['a refused connection', 'connection-refused', 0],
  ] as const)('treats %s as the defined free decision', async (_name, failure, expectedUnloads) => {
    const models = config();
    const state = makeServerState();
    const other = makeUnloadedServerState('model-y');
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(
        new Map([
          ['http://127.0.0.1:8090', state],
          ['http://127.0.0.1:8091', other],
        ]),
        requests,
      ),
    );

    await external.unload('x');
    state.failure = failure;
    state.unloads = 0;
    requests.length = 0;

    await external.unloadAll();

    expect(state.unloads).toBe(expectedUnloads);
    expect(requests.some((request) => request.startsWith('POST '))).toBe(expectedUnloads === 1);
  });

  it('does not probe an unconfigured server endpoint', async () => {
    const models = config();
    const configured = makeServerState();
    const unconfigured = makeServerState('hand-started-model');
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(
        new Map([
          ['http://127.0.0.1:8090', configured],
          ['http://127.0.0.1:8099', unconfigured],
        ]),
        requests,
      ),
    );

    await external.reconcileForFree(external.managedNames());

    expect(requests.every((request) => !request.includes(':8099/'))).toBe(true);
  });

  it('probes an endpoint shared by multiple config entries only once', async () => {
    const models = config();
    models.models[1].endpoint = models.models[0].endpoint;
    const state = makeServerState();
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(new Map([['http://127.0.0.1:8090', state]]), requests),
    );

    await external.reconcileForFree(external.managedNames());

    expect(requests.filter((request) => request.endsWith('/v1/models'))).toHaveLength(1);
  });
});

describe('probeExternalModelResidency', () => {
  const endpoint = 'http://127.0.0.1:8090';

  it('classifies a loaded model and reads only /v1/models', async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      return new Response(
        JSON.stringify({ data: [{ id: 'model-x', status: { value: 'loaded' } }] }),
        { status: 200 },
      );
    };

    await expect(
      probeExternalModelResidency(endpoint, 'model-x', undefined, fetchImpl),
    ).resolves.toEqual({ state: 'loaded', matchesModel: true });
    expect(requests).toEqual(['/v1/models']);
  });

  it('classifies the 21:29 empty-models Strata claim as stale', async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      return new Response(
        JSON.stringify(
          url.pathname === '/v1/models'
            ? { data: [] }
            : { service: 'strata', model: 'deepseek-v4.1-flash', loaded: true },
        ),
        { status: 200 },
      );
    };

    await expect(
      probeExternalModelResidency(endpoint, 'deepseek-v4.1-flash', undefined, fetchImpl),
    ).resolves.toEqual({ state: 'stale-claim' });
    expect(requests).toEqual(['/v1/models', '/v1/status']);
  });

  it.each([
    ['absent claim', {}],
    ['non-Strata claim', { service: 'other', model: 'model-x', loaded: true }],
    ['claim marked unloaded', { service: 'strata', model: 'model-x', loaded: false }],
  ])('classifies %s as unloaded', async (_name, status) => {
    const fetchImpl: typeof fetch = async (input) =>
      new Response(JSON.stringify(String(input).endsWith('/v1/models') ? { data: [] } : status), {
        status: 200,
      });

    await expect(
      probeExternalModelResidency(endpoint, 'model-x', undefined, fetchImpl),
    ).resolves.toEqual({ state: 'unloaded' });
  });

  it('classifies a connection refusal separately', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const fetchImpl: typeof fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause });
    };

    await expect(
      probeExternalModelResidency(endpoint, 'model-x', undefined, fetchImpl),
    ).resolves.toEqual({ state: 'connection-refused' });
  });

  it.each([
    [
      'a timeout',
      async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ],
    ['a non-200 response', async () => new Response('{}', { status: 503 })],
    ['an unparseable model body', async () => new Response('{', { status: 200 })],
  ])('classifies %s as unknown', async (_name, respond) => {
    const fetchImpl: typeof fetch = async () => respond();

    await expect(
      probeExternalModelResidency(endpoint, 'model-x', undefined, fetchImpl),
    ).resolves.toEqual({ state: 'unknown' });
  });

  it('classifies a non-200 status response as unknown', async () => {
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/v1/models')
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response('{}', { status: 503 });

    await expect(
      probeExternalModelResidency(endpoint, 'model-x', undefined, fetchImpl),
    ).resolves.toEqual({ state: 'unknown' });
  });

  it('does not match a different loaded model id, but accepts a sole unnamed model', async () => {
    const differentIdFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: 'other-model', status: { value: 'loaded' } }] }));
    const unnamedFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [{ status: { value: 'loaded' } }] }));

    await expect(
      probeExternalModelResidency(endpoint, 'model-x', undefined, differentIdFetch),
    ).resolves.toEqual({ state: 'loaded', matchesModel: false });
    await expect(
      probeExternalModelResidency(endpoint, 'model-x', undefined, unnamedFetch),
    ).resolves.toEqual({ state: 'loaded', matchesModel: true });
  });
});

describe('managed residency selector and source contracts', () => {
  it('shows another window’s loaded model only when its id matches', async () => {
    const models = config();
    const state = makeServerState();
    const requests: string[] = [];
    const windowA = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(new Map([['http://127.0.0.1:8090', state]]), requests),
    );
    const windowB = new ExternalModelServers(
      () => models,
      async () => undefined,
    );

    windowB.markInUse('x');
    await windowA.refreshResidency();
    expect(windowA.isConfirmedLoaded('x')).toBe(true);
  });

  it.each([
    ['a stale claim', { data: [] }, { service: 'strata', model: 'model-x', loaded: true }],
    [
      'a different model id',
      { data: [{ id: 'other-model', status: { value: 'loaded' } }] },
      { service: 'strata', model: 'other-model', loaded: true },
    ],
  ])('does not show %s as loaded in the selector', async (_name, modelsBody, statusBody) => {
    const models = config();
    const state = makeServerState();
    state.models = modelsBody;
    state.status = statusBody;
    const requests: string[] = [];
    const external = new ExternalModelServers(
      () => models,
      async () => undefined,
      makeFetch(new Map([['http://127.0.0.1:8090', state]]), requests),
    );

    await external.refreshResidency();

    expect(external.isConfirmedLoaded('x')).toBe(false);
  });

  it('does not use process inspection to discover managed residency', () => {
    const backend = path.join(process.cwd(), 'src/backend');
    const sourceFiles = (directory: string): string[] =>
      fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(file);
        return entry.isFile() && entry.name.endsWith('.ts') ? [fs.readFileSync(file, 'utf8')] : [];
      });

    expect(sourceFiles(backend).join('\n')).not.toMatch(/\b(?:tasklist|Get-Process)\b/i);
  });
});
