import { describe, expect, it, vi } from 'vitest';
import {
  llamaBinaryImpact,
  restartBackend,
  restartModelBackend,
  startBackend,
} from '../../src/backend/restartBackend';
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
    release: vi.fn(async (name: string) => void calls.push(`release ${name}`)),
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

describe('llamaBinaryImpact', () => {
  it('is llama only for models Forge spawns a llama-server for', () => {
    expect(llamaBinaryImpact(config, 'gguf')).toBe('llama');
    expect(llamaBinaryImpact(config, 'strata')).toBe('other');
    expect(llamaBinaryImpact(config, 'nope')).toBe('unknown');
  });

  it('resolves aliases, @profile suffixes, short names, case and group-inherited providers', () => {
    // The switch asks this about the config's `active_model`, which may be a
    // shorthand, and a `provider` is routinely inherited from a group — a raw
    // exact-name lookup classifies both wrongly (Codex review 2026-11-17).
    const cfg = {
      ...config,
      aliases: { 'my-gguf': 'gguf' },
      groups: { o: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434' } },
      models: [
        ...config.models,
        { name: 'o-model', group: 'o' },
        { name: 'coded', short_name: 'cd', provider: 'llama.cpp', gguf_path: 'C:/c.gguf' },
      ],
    } as unknown as ForgeConfig;
    expect(llamaBinaryImpact(cfg, 'my-gguf')).toBe('llama');
    expect(llamaBinaryImpact(cfg, 'gguf@main')).toBe('llama');
    expect(llamaBinaryImpact(cfg, 'o-model')).toBe('other');
    expect(llamaBinaryImpact(cfg, 'cd')).toBe('llama');
    expect(llamaBinaryImpact(cfg, 'GGUF')).toBe('llama');
  });

  it('reads a managed server through its engine, like the request path', () => {
    // A Strata entry whose `unload_path` lives in the engine (policy.yaml),
    // exactly as the migrated configs look: only the engine-folded entry is
    // "managed", so only the folded entry can be "other".
    const cfg = {
      ...config,
      engines: { 'e-strata': { unload_path: '/unload' } },
      models: [
        ...config.models,
        {
          name: 'engine-strata',
          provider: 'openai-compatible',
          endpoint: 'http://127.0.0.1:8096',
          engine: 'e-strata',
        },
      ],
    } as unknown as ForgeConfig;
    expect(llamaBinaryImpact(cfg, 'engine-strata')).toBe('other');
  });
});

describe('restartModelBackend', () => {
  it('releases, then restarts a managed server through prepareExternal', async () => {
    const { pool, calls } = fakePool();
    await restartModelBackend(pool, config, 'strata');
    expect(calls).toEqual(['release strata', 'prepare strata']);
  });

  it('releases, then restarts a llama.cpp model through acquire', async () => {
    const { pool, calls } = fakePool();
    await restartModelBackend(pool, config, 'gguf');
    expect(calls).toEqual(['release gguf', 'acquire gguf']);
  });
});
