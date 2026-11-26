import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { MonitorPollerOptions } from '../../src/monitor/monitorPollers';
import { createMonitorPollers, shownModel } from '../../src/monitor/monitorPollers';
import { noModelLoadedMessage } from '../../src/monitor/monitorTypes';

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

describe('a Monitor panel whose model goes away', () => {
  // The page keeps the last document it was sent, so a reader that answers nothing
  // leaves the unloaded model's name, `live.state: generating` and tok/s on screen.
  it('posts an empty state instead of leaving the last reading on the page', async () => {
    let loaded = true;
    const posts: Record<string, unknown>[] = [];
    const pollers = createMonitorPollers({
      pool: { isLoaded: () => loaded, isModelReady: () => loaded, modelBaseUrl: () => null },
      getConfig: () => ({ active_model: 'nemo', models: [{ name: 'nemo' }] }) as ForgeConfig,
      getStats: () => ({}) as never,
      getSecret: async () => undefined,
      probeGpus: async () => [] as never,
      post: (metrics: Record<string, unknown>) => posts.push(metrics),
    } as unknown as MonitorPollerOptions);
    pollers.start();
    try {
      await vi.waitFor(() => expect(posts.some((post) => post.engine !== undefined)).toBe(true));
      loaded = false;
      await vi.waitFor(() => expect(typeof posts[posts.length - 1]?.error).toBe('string'), {
        timeout: 6_000,
        interval: 50,
      });
      expect(posts[posts.length - 1]?.error).toBe(noModelLoadedMessage());
      // Load again, then unload again: the second unload has to announce itself too,
      // or the page keeps the second model's numbers forever.
      loaded = true;
      await vi.waitFor(() => expect(posts[posts.length - 1]?.engine).toBeDefined(), {
        timeout: 6_000,
        interval: 50,
      });
      loaded = false;
      await vi.waitFor(() => expect(posts[posts.length - 1]?.error).toBe(noModelLoadedMessage()), {
        timeout: 6_000,
        interval: 50,
      });
      // Each empty state is posted once, not by every reader on every tick.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(posts.filter((post) => post.error !== undefined)).toHaveLength(2);
    } finally {
      pollers.dispose();
    }
  }, 30_000);

  // Hiding the panel cancels the read in flight, which is not "nothing loaded": the
  // catch in `run` must stay silent so the page does not come back to an error state.
  it('stays silent while a hidden panel aborts the read in flight', async () => {
    const posts: Record<string, unknown>[] = [];
    const pollers = createMonitorPollers({
      pool: {
        isLoaded: () => true,
        isModelReady: () => true,
        modelBaseUrl: () => 'http://127.0.0.1:9',
      },
      getConfig: () => ({ active_model: 'nemo', models: [{ name: 'nemo' }] }) as ForgeConfig,
      getStats: () => ({}) as never,
      getSecret: async () => undefined,
      probeGpus: (_signal: AbortSignal) => new Promise<never>(() => {}),
      post: (metrics: Record<string, unknown>) => posts.push(metrics),
    } as unknown as MonitorPollerOptions);
    pollers.start();
    pollers.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts).toHaveLength(0);
    pollers.dispose();
  });
});
