import { describe, expect, it, vi } from 'vitest';
import { restartBackend, startBackend } from '../../src/backend/restartBackend';
import type { IBackendPool } from '../../src/backend/poolTypes';
import type { ForgeConfig } from '../../src/config/types';

const config = {
  models: [
    { name: 'gguf', provider: 'llama.cpp', gguf_path: 'C:/m.gguf' },
    {
      name: 'strata',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8095',
      unload_path: '/unload',
    },
  ],
} as unknown as ForgeConfig;

function fakePool(withPrepare = true) {
  const calls: string[] = [];
  const pool = {
    stopAll: vi.fn(async () => void calls.push('stopAll')),
    acquire: vi.fn(async (name: string) => void calls.push(`acquire ${name}`)),
    ...(withPrepare
      ? { prepareExternal: vi.fn(async (name: string) => void calls.push(`prepare ${name}`)) }
      : {}),
  } as unknown as IBackendPool;
  return { pool, calls };
}

describe('restartBackend', () => {
  it('starts a managed server through prepareExternal, never llama-server', async () => {
    const { pool, calls } = fakePool();
    await restartBackend(pool, config, 'strata');
    expect(calls).toEqual(['stopAll', 'prepare strata']);
  });

  it('restarts a llama.cpp model through acquire', async () => {
    const { pool, calls } = fakePool();
    const onStopped = vi.fn(() => calls.push('stopped'));
    await restartBackend(pool, config, 'gguf', onStopped);
    expect(calls).toEqual(['stopAll', 'stopped', 'acquire gguf']);
  });

  it('refuses a managed model before stopping anything when the pool cannot start it', async () => {
    const { pool, calls } = fakePool(false);
    await expect(restartBackend(pool, config, 'strata')).rejects.toThrow(/cannot start/);
    expect(calls).toEqual([]);
  });

  it('startBackend routes the same way without stopping', async () => {
    const { pool, calls } = fakePool();
    await startBackend(pool, config, 'strata');
    await startBackend(pool, config, 'gguf');
    expect(calls).toEqual(['prepare strata', 'acquire gguf']);
  });
});
