import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendPool, IBackendPool } from '../../src/backend/BackendPool';
import type { ForgeConfig } from '../../src/config/types';

// Mock vscode before any imports that use it
vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn().mockReturnValue({
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

// Mock DirectBackend to avoid spawning real processes
vi.mock('../../src/backend/DirectBackend', () => ({
  DirectBackend: vi.fn().mockImplementation(() => ({
    hotSwap: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    stop: vi.fn().mockResolvedValue(undefined),
    showConsole: vi.fn(),
    baseUrl: vi.fn().mockReturnValue('http://127.0.0.1:8080'),
    loadedModel: vi.fn().mockReturnValue('test-model'),
    applyForgeConfig: vi.fn(),
  })),
}));

function makeConfig(overrides?: Partial<ForgeConfig>): ForgeConfig {
  return {
    models: [],
    active_model: null,
    llama_server: {
      binary: 'llama-server',
      host: '127.0.0.1',
      port: 8080,
    },
    max_simultaneous_models: 2,
    ...overrides,
  } as ForgeConfig;
}

describe('BackendPool', () => {
  let pool: IBackendPool;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (pool) await pool.stopAll();
  });

  it('acquires a new slot when model is not in pool', async () => {
    pool = new BackendPool(makeConfig());
    const backend = await pool.acquire('test-model');
    expect(backend).toBeDefined();
    expect(backend.isReady()).toBe(true);
    expect(backend.baseUrl()).toBe('http://127.0.0.1:8080');
  });

  it('reuses existing slot for same model', async () => {
    pool = new BackendPool(makeConfig());
    const first = await pool.acquire('test-model');
    const second = await pool.acquire('test-model');
    expect(first).toBe(second);
  });

  it('acquires different models on different ports', async () => {
    pool = new BackendPool(makeConfig({ max_simultaneous_models: 2 }));
    const backend1 = await pool.acquire('model-a');
    const backend2 = await pool.acquire('model-b');
    expect(backend1).not.toBe(backend2);
  });

  it('evicts LRU slot when pool is full', async () => {
    const { DirectBackend } = await import('../../src/backend/DirectBackend');
    pool = new BackendPool(makeConfig({ max_simultaneous_models: 1 }));

    await pool.acquire('model-a');
    await pool.acquire('model-b');

    // model-a should have been stopped (evicted)
    const mockInstances = vi.mocked(DirectBackend).mock.results;
    const firstInstance = mockInstances[0]?.value;
    expect(firstInstance?.stop).toHaveBeenCalled();
  });

  it('isAnyReady returns true when at least one slot is ready', async () => {
    pool = new BackendPool(makeConfig());
    expect(pool.isAnyReady()).toBe(false);
    await pool.acquire('test-model');
    expect(pool.isAnyReady()).toBe(true);
  });

  it('stops all slots and clears pool', async () => {
    pool = new BackendPool(makeConfig({ max_simultaneous_models: 2 }));
    await pool.acquire('model-a');
    await pool.acquire('model-b');

    await pool.stopAll();
    expect(pool.isAnyReady()).toBe(false);
  });

  it('applyForgeConfig propagates to all slots', async () => {
    const { DirectBackend } = await import('../../src/backend/DirectBackend');
    pool = new BackendPool(makeConfig({ max_simultaneous_models: 2 }));
    await pool.acquire('model-a');
    await pool.acquire('model-b');

    const newConfig = makeConfig({ active_model: 'model-b' });
    pool.applyForgeConfig(newConfig);

    const mockInstances = vi.mocked(DirectBackend).mock.instances;
    for (const instance of mockInstances) {
      expect(instance.applyForgeConfig).toHaveBeenCalledWith(newConfig);
    }
  });

  it('showConsole targets last acquired model by default', async () => {
    const { DirectBackend } = await import('../../src/backend/DirectBackend');
    pool = new BackendPool(makeConfig({ max_simultaneous_models: 2 }));
    await pool.acquire('model-a');
    await pool.acquire('model-b');

    pool.showConsole();
    const mockInstances = vi.mocked(DirectBackend).mock.instances;
    // Should show console for model-b (most recent)
    expect(mockInstances[1]?.showConsole).toHaveBeenCalled();
  });

  it('showConsole targets specific model when named', async () => {
    const { DirectBackend } = await import('../../src/backend/DirectBackend');
    pool = new BackendPool(makeConfig({ max_simultaneous_models: 2 }));
    await pool.acquire('model-a');
    await pool.acquire('model-b');

    pool.showConsole('model-a');
    const mockInstances = vi.mocked(DirectBackend).mock.instances;
    expect(mockInstances[0]?.showConsole).toHaveBeenCalled();
  });

  it('restarts crashed slot on re-acquire', async () => {
    const { DirectBackend } = await import('../../src/backend/DirectBackend');
    pool = new BackendPool(makeConfig());

    // First acquire — returns ready backend
    await pool.acquire('model-a');

    // Simulate crash: mock returns not ready
    const mockInstance = vi.mocked(DirectBackend).mock.instances[0];
    vi.mocked(mockInstance.isReady).mockReturnValue(false);
    vi.mocked(mockInstance.hotSwap).mockResolvedValue(undefined);
    vi.mocked(mockInstance.isReady).mockReturnValue(true);

    // Re-acquire should restart
    const backend = await pool.acquire('model-a');
    expect(mockInstance.hotSwap).toHaveBeenCalledTimes(2); // once initial + once restart
    expect(backend.isReady()).toBe(true);
  });

  it('throws when no slots available and no eviction candidate', async () => {
    // This is hard to trigger because we always have at least one slot
    // But we can test by mocking the pool internals indirectly
    const config = makeConfig({ max_simultaneous_models: 0 });
    pool = new BackendPool(config);
    await expect(pool.acquire('test-model')).rejects.toThrow();
  });
});
