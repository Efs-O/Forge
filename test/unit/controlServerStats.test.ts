import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlServer } from '../../src/backend/ControlServer';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { ForgeConfig } from '../../src/config/types';
import { createControlStatsBuilder, controlStatsSchema } from '../../src/backend/controlStats';

const pool: IBackendPool = {
  acquire: async () => {
    throw new Error('not used');
  },
  release: async () => {},
  stopAll: async () => {},
  applyForgeConfig: () => {},
  showConsole: () => {},
  isAnyReady: () => false,
  loadedModelNames: () => [],
  isBusy: () => false,
  loadedModelsExcept: () => [],
  isLoaded: () => false,
};

describe('ControlServer GET /stats', () => {
  let server: ControlServer | undefined;

  afterEach(() => {
    server?.dispose();
    server = undefined;
  });

  it('returns 200 with a body that parses with the stats schema', async () => {
    const stats = createControlStatsBuilder({
      sessionsDir: path.join(os.tmpdir(), `forge-control-server-stats-${process.pid}`),
      now: Date.now,
      contextLimitFor: () => null,
      forgeVersion: 'test-version',
    });
    server = new ControlServer(
      pool,
      {
        models: [],
        llama_server: {},
        control_server: { enabled: true, port: 0 },
      } as ForgeConfig,
      { stats, probe: async () => true },
    );
    server.start();

    // Port 0: the OS picks a free one, so nothing else can hold or answer it.
    await vi.waitFor(() => expect(server?.status().port).toBeGreaterThan(0));
    const base = `http://127.0.0.1:${server.status().port}`;
    const response = await fetch(`${base}/stats`);
    expect(response.status).toBe(200);
    expect(controlStatsSchema.parse(await response.json())).toMatchObject({
      forge_version: 'test-version',
      today: { turns: 0, requests: 0 },
    });
  });
});
