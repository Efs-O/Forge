/**
 * The Monitor's two additions of 2026-11-24: CPU package readings from
 * LibreHardwareMonitor (`src/monitor/lhmCpuStats.ts` and its config key), and the
 * panel opening itself when a model server starts (`src/backend/modelServerReady.ts`).
 *
 * The sensor-tree tests are the port's contract with Strata's `_LhmCpu`
 * (`serve/telemetry.py`, branch `monitor/cards-gpu-selector`): the same tree has
 * to give the same numbers, including the string forms LibreHardwareMonitor
 * actually sends (`"62.0 °C"`, `"45,3 W"`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const createOrShow = vi.hoisted(() => vi.fn());
const registered = vi.hoisted(() => new Map<string, () => void>());
vi.mock('../../src/monitor/MonitorPanel', () => ({ MonitorPanel: { createOrShow } }));
vi.mock('../../src/sidebar/modelManager/ModelManagerPanel', () => ({
  ModelManagerPanel: { createOrShow: vi.fn() },
}));
// The shared vscode stub has no command registry, which is the one thing these
// tests are about: the Monitor's own command, and the listener the window leaves
// behind for the backend pool.
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode')>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      registerCommand: (name: string, handler: () => void) => {
        registered.set(name, handler);
        return { dispose: () => undefined };
      },
    },
  };
});

import { readLhmCpuStats, readLhmCpuTree } from '../../src/monitor/lhmCpuStats';
import {
  notifyModelServerReady,
  setModelServerReadyListener,
} from '../../src/backend/modelServerReady';
import { registerSidebarCommands } from '../../src/vscode/sidebarCommands';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';

afterEach(() => {
  createOrShow.mockClear();
  registered.clear();
  setModelServerReadyListener(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readLhmCpuTree', () => {
  it('picks the package sensors by name and ignores cores and GPUs', () => {
    const tree = {
      SensorId: null,
      Text: 'Computer',
      Children: [
        {
          SensorId: '/intelcpu/0',
          Text: 'Intel CPU i9-9900KF',
          Children: [
            { SensorId: '/intelcpu/0/temperature/10', Text: 'CPU Package', Value: '62.0 °C' },
            { SensorId: '/intelcpu/0/temperature/1', Text: 'CPU Core #1', Value: '70.0 °C' },
            { SensorId: '/intelcpu/0/power/0', Text: 'CPU Package', Value: '45,3 W' },
          ],
        },
        {
          SensorId: '/gpu-nvidia/0',
          Text: 'NVIDIA GeForce',
          Children: [
            { SensorId: '/gpu-nvidia/0/temperature/0', Text: 'GPU Core', Value: '41.0 °C' },
          ],
        },
      ],
    };
    expect(readLhmCpuTree(tree)).toEqual({ tempC: 62, powerW: 45.3 });
  });

  it('falls back to the AMD die sensor when there is no CPU Package sensor', () => {
    const tree = [
      {
        Text: 'Computer',
        Children: [
          {
            Text: 'AMD CPU',
            Children: [
              { SensorId: '/amdcpu/0/temperature/2', Text: 'Core (Tctl/Tdie)', Value: '58.5 °C' },
              { SensorId: '/amdcpu/0/power/3', Text: 'Package (PPT)', Value: '88.25 W' },
            ],
          },
        ],
      },
    ];
    // `Package (PPT)` is not one of the power names LibreHardwareMonitor uses,
    // so the power reading stays null rather than inventing a sensor.
    expect(readLhmCpuTree(tree)).toEqual({ tempC: 58.5, powerW: null });
  });

  it('reports no reading for a tree with no CPU sensors', () => {
    expect(readLhmCpuTree({})).toEqual({ tempC: null, powerW: null });
    expect(readLhmCpuTree(null)).toEqual({ tempC: null, powerW: null });
  });
});

describe('readLhmCpuStats', () => {
  it('names the server and its status when the web server answers badly', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(
      readLhmCpuStats('http://127.0.0.1:8085/data.json', new AbortController().signal, fetchImpl),
    ).rejects.toThrow('LibreHardwareMonitor at http://127.0.0.1:8085/data.json answered 503');
  });

  it('parses the JSON body of a good answer', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            SensorId: '/intelcpu/0/temperature/10',
            Text: 'CPU Package',
            Value: '61.5 °C',
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await expect(
      readLhmCpuStats('http://127.0.0.1:8085/data.json', new AbortController().signal, fetchImpl),
    ).resolves.toEqual({ tempC: 61.5, powerW: null });
  });
});

describe('the monitor.cpu config key', () => {
  // The schema wants a real config around the key under test.
  const base = () => ({
    models: [{ name: 'demo', provider: 'openai-compatible', endpoint: 'http://127.0.0.1:8090/v1' }],
    active_model: 'demo',
    llama_server: {},
  });
  const parse = (cpu: string) => ForgeConfigSchema.safeParse({ ...base(), monitor: { cpu } });

  it.each([
    'http://127.0.0.1:8085/data.json',
    'http://localhost:8085/data.json',
    'http://[::1]:8085/data.json',
  ])('accepts the loopback URL %s', (cpu) => {
    expect(parse(cpu).success).toBe(true);
  });

  it.each(['http://192.168.1.75:8085/data.json', 'https://example.com/data.json'])(
    'refuses %s with the documented wording',
    (cpu) => {
      const result = parse(cpu);
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues[0].message).toBe(
          'monitor.cpu must point at this machine (127.0.0.1, ::1 or localhost); Forge does not reach other hosts for CPU readings.',
        );
    },
  );

  it('accepts auto_open as a boolean and keeps rejecting unknown keys', () => {
    expect(ForgeConfigSchema.safeParse({ ...base(), monitor: { auto_open: false } }).success).toBe(
      true,
    );
    expect(
      ForgeConfigSchema.safeParse({
        ...base(),
        monitor: { cpus: 'http://127.0.0.1:8085/data.json' },
      }).success,
    ).toBe(false);
  });
});

describe('the model-server-ready signal', () => {
  /** Wire the sidebar commands against a fake extension host and return the
   *  config the window reads, so a test can flip `monitor.auto_open`. */
  const registerWith = (monitor?: { cpu?: string; auto_open?: boolean }) => {
    const config = { models: [], monitor } as unknown as ForgeConfig;
    const context = {
      extensionUri: { fsPath: 'extension' },
      subscriptions: [] as Array<{ dispose(): void }>,
    } as never;
    registerSidebarCommands(context, {
      pool: {} as never,
      sidebar: {} as never,
      getConfig: () => config,
      getConfigPath: () => 'config.yaml',
      getStats: () => ({}) as never,
      getSecret: async () => undefined,
    });
    return context as unknown as { subscriptions: Array<{ dispose(): void }> };
  };

  it('opens the panel in the background once, and never again after it is closed', () => {
    registerWith();
    notifyModelServerReady('maya-maya-s24');
    expect(createOrShow).toHaveBeenCalledTimes(1);
    expect(createOrShow.mock.calls[0][2]).toEqual({ background: true });
    notifyModelServerReady('maya-maya-s24');
    expect(createOrShow).toHaveBeenCalledTimes(1);
  });

  it('still opens the panel normally from the command palette', () => {
    registerWith();
    registered.get('forge.openMonitor')?.();
    expect(createOrShow).toHaveBeenCalledTimes(1);
    expect(createOrShow.mock.calls[0][2]).toBeUndefined();
  });

  it('stays shut with monitor.auto_open: false, and on later starts', () => {
    registerWith({ auto_open: false });
    notifyModelServerReady('maya-maya-s24');
    notifyModelServerReady('maya-maya-s24');
    expect(createOrShow).not.toHaveBeenCalled();
  });

  it('stops listening when the window is disposed', () => {
    const context = registerWith();
    for (const subscription of context.subscriptions) subscription.dispose();
    notifyModelServerReady('maya-maya-s24');
    expect(createOrShow).not.toHaveBeenCalled();
  });

  it('swallows a listener that throws, so a failed panel never fails a start', () => {
    setModelServerReadyListener(() => {
      throw new Error('webview refused to open');
    });
    expect(() => notifyModelServerReady('m')).not.toThrow();
  });

  it('reaches the listener the window set, and nothing once it is cleared', () => {
    const seen: string[] = [];
    setModelServerReadyListener((modelName) => seen.push(modelName));
    notifyModelServerReady('maya-maya-s24');
    expect(seen).toEqual(['maya-maya-s24']);
    setModelServerReadyListener(undefined);
    notifyModelServerReady('maya-maya-s24');
    expect(seen).toEqual(['maya-maya-s24']);
  });
});
