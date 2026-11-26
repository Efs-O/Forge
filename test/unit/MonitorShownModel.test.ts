import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { MonitorPollerOptions } from '../../src/monitor/monitorPollers';
import { createMonitorPollers, shownModel } from '../../src/monitor/monitorPollers';

const config: ForgeConfig = {
  active_model: 'strata-x',
  models: [
    {
      name: 'strata-x',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8091/v1',
      stats: 'strata',
    },
    { name: 'gemma-x', provider: 'llama.cpp' },
  ],
};

describe('shownModel', () => {
  it.each([
    [
      'prefers the serving model over a stale active external engine',
      { 'strata-x': { loaded: true, ready: false }, 'gemma-x': { loaded: true, ready: true } },
      'gemma-x',
    ],
    [
      'prefers the active model among ready models',
      { 'strata-x': { loaded: true, ready: true }, 'gemma-x': { loaded: true, ready: true } },
      'strata-x',
    ],
    [
      'keeps the active model when no loaded model is ready',
      { 'strata-x': { loaded: true, ready: false }, 'gemma-x': { loaded: true, ready: false } },
      'strata-x',
    ],
    [
      'returns the only loaded model even when it is not ready',
      { 'strata-x': { loaded: false, ready: false }, 'gemma-x': { loaded: true, ready: false } },
      'gemma-x',
    ],
    [
      'returns undefined when nothing is loaded',
      { 'strata-x': { loaded: false, ready: false }, 'gemma-x': { loaded: false, ready: false } },
      undefined,
    ],
  ])('%s', (_description, status, expected) => {
    const options = {
      pool: {
        isLoaded: (name: string) => status[name as keyof typeof status].loaded,
        isModelReady: (name: string) => status[name as keyof typeof status].ready,
      },
    } as MonitorPollerOptions;

    expect(shownModel(options, config)?.name).toBe(expected);
  });
});

describe('a model entry with no provider line', () => {
  // The schema reads a missing provider as llama.cpp, and most GGUF entries leave it out.
  // The Monitor compared provider === 'llama.cpp', so such a model got no reading at all
  // (2026-11-26, Nemotron and Gemma both showed only dashes).
  it('is read as a Forge-spawned llama-server', async () => {
    const posts: Record<string, unknown>[] = [];
    const pollers = createMonitorPollers({
      pool: { isLoaded: () => true, isModelReady: () => true, modelBaseUrl: () => null },
      getConfig: () => ({ active_model: 'nemo', models: [{ name: 'nemo' }] }) as ForgeConfig,
      getStats: () => ({}) as never,
      getSecret: async () => undefined,
      probeGpus: async () => [{ index: 0, name: 'Test GPU', utilizationPercent: 12 }] as never,
      post: (metrics: Record<string, unknown>) => posts.push(metrics),
    } as unknown as MonitorPollerOptions);
    pollers.start();
    try {
      await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
      expect((posts[0].engine as { model: string }).model).toBe('nemo');
    } finally {
      pollers.dispose();
    }
  });
});
