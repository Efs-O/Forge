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
