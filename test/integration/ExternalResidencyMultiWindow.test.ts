import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareExternalForRequest } from '../../src/backend/BackendPoolExternal';
import { ExternalModelServers } from '../../src/backend/ExternalModelServers';
import { SharedRuntimeRegistry } from '../../src/backend/SharedRuntimeRegistry';
import type { ForgeConfig } from '../../src/config/types';
import { listenLoopback } from '../support/listenLoopback';

interface FakeStrata {
  models: Array<{ id: string; status: { value: 'loaded' | 'unloaded' } }>;
  status: { service: string; model: string; loaded: boolean };
  events: string[];
  unloads: number;
}

function startFakeStrata(state: FakeStrata): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: state.models }));
    } else if (request.url === '/v1/status') {
      response.end(JSON.stringify(state.status));
    } else if (request.url === '/unload' && request.method === 'POST') {
      const model = state.models.find((entry) => entry.status.value === 'loaded')?.id ?? 'empty';
      state.events.push(`unload:${model}`);
      state.unloads += 1;
      state.models = [];
      state.status = { service: 'strata', model, loaded: false };
      response.end('{}');
    } else {
      response.end('{}');
    }
  });
  return listenLoopback(server).then((port) => ({ port, server }));
}

const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

function config(port: number): ForgeConfig {
  return {
    active_model: 'y',
    llama_server: { port: 9100 },
    models: [
      {
        name: 'x',
        provider: 'openai-compatible',
        endpoint: `http://127.0.0.1:${port}`,
        model: 'model-x',
        unload_path: '/unload',
        gpus: [0],
      },
      {
        name: 'y',
        provider: 'openai-compatible',
        endpoint: `http://127.0.0.1:${port}`,
        model: 'model-y',
        unload_path: '/unload',
        gpus: [0],
      },
    ],
  } as ForgeConfig;
}

describe('managed external residency across two windows', () => {
  let root: string;
  let state: FakeStrata;
  let fake: Awaited<ReturnType<typeof startFakeStrata>>;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-external-residency-multiwindow-'));
    state = {
      models: [{ id: 'model-x', status: { value: 'loaded' } }],
      status: { service: 'strata', model: 'model-x', loaded: true },
      events: [],
      unloads: 0,
    };
    fake = await startFakeStrata(state);
  });

  afterEach(async () => {
    await closeServer(fake.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('unloads X before Y starts when A remembers X as unloaded and B loaded it', async () => {
    const models = config(fake.port);
    const windowA = new ExternalModelServers(
      () => models,
      async () => undefined,
    );
    const windowB = new ExternalModelServers(
      () => models,
      async () => undefined,
    );
    const registryA = new SharedRuntimeRegistry(root);
    const originalEnsureStarted = windowA.ensureStarted.bind(windowA);
    vi.spyOn(windowA, 'ensureStarted').mockImplementation(async (name) => {
      state.events.push(`start:${name}`);
      await originalEnsureStarted(name);
    });

    await windowA.unload('x');
    state.events.length = 0;
    state.unloads = 0;
    state.models = [{ id: 'model-x', status: { value: 'loaded' } }];
    state.status = { service: 'strata', model: 'model-x', loaded: true };
    windowB.markInUse('x');

    await prepareExternalForRequest('y', {
      external: windowA,
      slots: new Map(),
      ollamaSlots: new Map(),
      sharedSlots: new Map(),
      registry: registryA,
      sharedRuntimeEnabled: false,
      runtimeKey: () => 'unused',
      freeSlot: () => {},
      isBusy: () => false,
      isDelegationPinned: () => false,
      isOllamaModel: () => false,
    });

    expect(state.events).toEqual(['unload:model-x', 'start:y']);
    expect(state.unloads).toBe(1);
    expect(windowA.isConfirmedLoaded('y')).toBe(true);
  });

  it('refuses Y while B holds X for a turn and sends no unload', async () => {
    const models = config(fake.port);
    const windowA = new ExternalModelServers(
      () => models,
      async () => undefined,
    );
    const windowB = new ExternalModelServers(
      () => models,
      async () => undefined,
    );
    const registryA = new SharedRuntimeRegistry(root);
    const registryB = new SharedRuntimeRegistry(root);

    await windowA.unload('x');
    state.events.length = 0;
    state.unloads = 0;
    state.models = [{ id: 'model-x', status: { value: 'loaded' } }];
    state.status = { service: 'strata', model: 'model-x', loaded: true };
    windowB.markInUse('x');
    const hold = await registryB.acquireExternalTurnHold(
      'x',
      'window-b-chat',
      'Window B active turn',
      () => true,
    );

    try {
      await expect(
        prepareExternalForRequest('y', {
          external: windowA,
          slots: new Map(),
          ollamaSlots: new Map(),
          sharedSlots: new Map(),
          registry: registryA,
          sharedRuntimeEnabled: false,
          runtimeKey: () => 'unused',
          freeSlot: () => {},
          isBusy: () => false,
          isDelegationPinned: () => false,
          isOllamaModel: () => false,
        }),
      ).rejects.toThrow(/x is serving chat 'Window B active turn'/);
      expect(state.events).toEqual([]);
      expect(state.unloads).toBe(0);
    } finally {
      await hold.release();
    }
  });
});
