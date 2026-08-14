import { describe, expect, it, vi } from 'vitest';
import { DirectBackend } from '../../src/backend/DirectBackend';
import type { ForgeConfig } from '../../src/config/types';

const { probeHealthy, probeServedModel } = vi.hoisted(() => ({
  probeHealthy: vi.fn(),
  probeServedModel: vi.fn(),
}));

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
