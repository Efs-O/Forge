import { describe, expect, it, vi } from 'vitest';
import { ConversationTabs, type ConversationTabsDeps } from '../../src/sidebar/ConversationTabs';
import type { ForgeConfig } from '../../src/config/types';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { SidebarRuntime } from '../../src/sidebar/sessionTypes';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function config(): ForgeConfig {
  return {
    models: [
      { name: '12b', provider: 'llama.cpp', gguf_path: '/12b.gguf' },
      { name: '27b', provider: 'llama.cpp', gguf_path: '/27b.gguf' },
      { name: 'grok', provider: 'xai' },
    ],
    active_model: '12b',
    llama_server: { port: 8080 },
    max_simultaneous_models: 4,
  } as ForgeConfig;
}

function sidebar(models: string[]): SidebarRuntime {
  return {
    activeConversationId: 'tab0',
    conversations: models.map((model, i) => ({
      id: `tab${i}`,
      title: `Tab ${i}`,
      createdAt: 1,
      updatedAt: 1,
      active_model: model,
      messages: [],
    })),
    history: [],
  };
}

function harness(options: { tabs?: string[]; streaming?: boolean; loaded?: string[] } = {}) {
  const state = sidebar(options.tabs ?? ['12b']);
  const release = vi.fn(async () => {});
  const posted: HostToWebview[] = [];
  const loaded = new Set(options.loaded ?? ['12b']);
  const deps = {
    workspaceState: { get: () => undefined, update: async () => {} },
    isStreaming: () => options.streaming ?? false,
    forgetBudget: () => {},
    getConfig: config,
    getSidebar: () => state,
    setSidebar: () => {},
    setActiveModel: () => {},
    persistSession: () => {},
    postModels: () => {},
    postSessionSync: () => {},
    pool: { release, isLoaded: (name: string) => loaded.has(name) },
    agentLoop: {},
    checkpoints: {},
    failureTracker: { reset: () => {} },
    events: {},
    post: (msg: HostToWebview) => posted.push(msg),
    // Base of "name@profile"; every fixture model here is already a base.
    baseOf: (id: string | null | undefined) => (id ? id.split('@')[0] : null),
    refreshUi: () => {},
  } as unknown as ConversationTabsDeps;
  return { tabs: new ConversationTabs(deps), release, posted };
}

describe('ConversationTabs.pinModel VRAM release', () => {
  it('frees the outgoing local model when the tab switches away from it', async () => {
    const { tabs, release, posted } = harness();

    tabs.pinModel('27b');
    await flush();

    // Without this the pool kept the 12B resident and spawned a second
    // llama-server for the 27B, which OOM'd the GPU.
    expect(release).toHaveBeenCalledWith('12b');
    expect(posted).toContainEqual({ type: 'backendDown', message: '12b unloaded.' });
  });

  it('keeps the model loaded while another tab still has it pinned', async () => {
    const { tabs, release } = harness({ tabs: ['12b', '12b'] });

    tabs.pinModel('27b');
    await flush();

    expect(release).not.toHaveBeenCalled();
  });

  it('does not stop a backend mid-stream', async () => {
    const { tabs, release } = harness({ streaming: true });

    tabs.pinModel('27b');
    await flush();

    expect(release).not.toHaveBeenCalled();
  });

  it('ignores cloud models, which hold no VRAM', async () => {
    const { tabs, release } = harness({ tabs: ['grok'], loaded: ['grok'] });

    tabs.pinModel('27b');
    await flush();

    expect(release).not.toHaveBeenCalled();
  });

  it('is a no-op when re-picking the same base model under a different profile', async () => {
    const { tabs, release } = harness({ tabs: ['12b@main'] });

    tabs.pinModel('12b@worker');
    await flush();

    expect(release).not.toHaveBeenCalled();
  });

  it('surfaces a refused release instead of leaving the user guessing', async () => {
    const { tabs, release, posted } = harness();
    release.mockRejectedValueOnce(new Error('an active delegation hold is using it'));

    tabs.pinModel('27b');
    await flush();

    expect(posted).toContainEqual({
      type: 'error',
      message: 'Still loaded — an active delegation hold is using it',
    });
  });
});
