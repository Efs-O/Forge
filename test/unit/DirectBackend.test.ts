import { describe, expect, it, vi } from 'vitest';
import { DirectBackend } from '../../src/backend/DirectBackend';
import type { ForgeConfig } from '../../src/config/types';

const { probeHealthy, probeServedModel, ensureOllamaReady, releaseOllamaModel } = vi.hoisted(
  () => ({
    probeHealthy: vi.fn(),
    probeServedModel: vi.fn(),
    ensureOllamaReady: vi.fn(),
    releaseOllamaModel: vi.fn(),
  }),
);

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), clear: vi.fn(), show: vi.fn() })),
  },
}));

vi.mock('../../src/backend/HealthCheck', () => ({
  probeHealthy,
  probeServedModel,
  waitForHealthy: vi.fn(),
}));

vi.mock('../../src/backend/OllamaAdapter', () => ({
  ensureOllamaReady,
  releaseOllamaModel,
  normalizeOllamaEndpoint: (value: string) => value,
}));

function config(): ForgeConfig {
  return {
    active_model: 'qwen',
    llama_server: { binary: 'llama-server.exe', host: '127.0.0.1', port: 8080 },
    models: [
      {
        name: 'qwen',
        provider: 'llama.cpp',
        gguf_path: 'N:/models/Qwen.gguf',
      },
      {
        name: 'llama3',
        provider: 'ollama',
        model: 'llama3:latest',
        endpoint: 'http://127.0.0.1:11434',
      },
    ],
  } as ForgeConfig;
}

describe('DirectBackend adopted server lifecycle', () => {
  it('does not claim it can unload a matching server owned by another window', async () => {
    probeHealthy.mockResolvedValue(true);
    probeServedModel.mockResolvedValue('N:/models/Qwen.gguf');
    const backend = new DirectBackend(config());

    await backend.hotSwap('qwen');

    await expect(backend.stop()).rejects.toThrow(/owned by another Forge window/i);
  });
});

/**
 * stop() erases ownership metadata, but only AFTER the release paths that read
 * it have run: releaseActiveOllamaModel() early-returns on a null activeModel,
 * so clearing state first turns the daemon release into a silent no-op and
 * leaks the model's VRAM.
 */
describe('DirectBackend stop() teardown ordering', () => {
  it('still releases a resident Ollama model before clearing its state', async () => {
    probeHealthy.mockResolvedValue(true);
    ensureOllamaReady.mockResolvedValue(undefined);
    releaseOllamaModel.mockClear();
    const backend = new DirectBackend(config());

    await backend.hotSwap('llama3');
    expect(backend.loadedModel()).toBe('llama3');

    await backend.stop();

    expect(releaseOllamaModel).toHaveBeenCalledWith('http://127.0.0.1:11434', 'llama3');
    expect(backend.loadedModel()).toBeNull();
    expect(backend.isReady()).toBe(false);
  });
});

/**
 * hotSwap() must NOT mutate the shared ForgeConfig.active_model.
 *
 * Before the fix, all three hotSwap branches (fast-path, Ollama, llama.cpp)
 * wrote `this.config.active_model = modelName`. Because the config object is
 * shared by reference with SidebarProvider, a throwaway delegation backend
 * (e.g. pinging an Ollama :cloud model) would stamp the live config with the
 * target model name, corrupting the picker and seeding new tabs with a
 * potentially paywalled model (402 hazard).
 *
 * loadedModel() already reports what a backend is serving via this.activeModel,
 * so no reader depends on hotSwap setting config.active_model.
 */
describe('DirectBackend hotSwap() must not mutate config.active_model', () => {
  it('fast path: already-active model does not overwrite config.active_model', async () => {
    probeHealthy.mockResolvedValue(true);
    probeServedModel.mockResolvedValue('N:/models/Qwen.gguf');
    const cfg = config();
    const backend = new DirectBackend(cfg);

    // First swap loads 'qwen' (active_model is already 'qwen').
    await backend.hotSwap('qwen');
    // Second swap hits the fast path (same model, ready).
    await backend.hotSwap('qwen');

    expect(cfg.active_model).toBe('qwen');
  });

  it('Ollama branch: swapping to an Ollama model does not overwrite config.active_model', async () => {
    probeHealthy.mockResolvedValue(true);
    ensureOllamaReady.mockResolvedValue(undefined);
    releaseOllamaModel.mockClear();
    const cfg = config();
    const backend = new DirectBackend(cfg);

    await backend.hotSwap('llama3');

    expect(backend.loadedModel()).toBe('llama3');
    expect(cfg.active_model).toBe('qwen'); // unchanged
  });

  it('llama.cpp branch: swapping to a llama.cpp model does not overwrite config.active_model', async () => {
    probeHealthy.mockResolvedValue(true);
    probeServedModel.mockResolvedValue('N:/models/Qwen.gguf');
    const cfg = config();
    // Start with a different active_model so we can detect a write.
    cfg.active_model = 'some-other-model';
    const backend = new DirectBackend(cfg);

    // Swap to 'qwen' (llama.cpp) from a fresh backend.
    await backend.hotSwap('qwen');

    expect(backend.loadedModel()).toBe('qwen');
    expect(cfg.active_model).toBe('some-other-model'); // unchanged — hotSwap must not write it
  });
});
