import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  composeEmbeddingServerArgs,
  EmbeddingBackend,
  embeddingModelMatches,
} from '../../src/backend/EmbeddingBackend';
import type { ForgeConfig } from '../../src/config/types';

const { spawnLlamaServer, killLlamaProcess, waitForHealthy, probeHealthy, probeServedModel } =
  vi.hoisted(() => ({
    spawnLlamaServer: vi.fn(),
    killLlamaProcess: vi.fn(),
    waitForHealthy: vi.fn(),
    probeHealthy: vi.fn(),
    probeServedModel: vi.fn(),
  }));

vi.mock('../../src/backend/llamaProcess', () => ({ spawnLlamaServer, killLlamaProcess }));
vi.mock('../../src/backend/HealthCheck', () => ({ waitForHealthy, probeHealthy, probeServedModel }));
vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      append: vi.fn(), appendLine: vi.fn(), clear: vi.fn(), show: vi.fn(), dispose: vi.fn(),
    }),
  },
}));

function fakeProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: null, stderr: null, exitCode: null, signalCode: null, pid: 123 });
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  spawnLlamaServer.mockImplementation(() => fakeProcess());
  killLlamaProcess.mockResolvedValue(undefined);
  waitForHealthy.mockResolvedValue({ ok: true });
  probeHealthy.mockResolvedValue(false);
  probeServedModel.mockResolvedValue(null);
});

function makeConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    models: [],
    active_model: null,
    llama_server: { binary: '/bin/llama-server' },
    embeddings: { enabled: true, model_path: '/models/embeddinggemma-300m.gguf' },
    ...overrides,
  } as ForgeConfig;
}

/** Reads the value following `flag` in the composed argv. */
function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('composeEmbeddingServerArgs', () => {
  it('throws when model_path is missing', () => {
    const config = makeConfig({ embeddings: { enabled: true } });
    expect(() => composeEmbeddingServerArgs(config)).toThrow(/model_path is not configured/);
  });

  it('sets ubatch equal to ctx so a whole chunk fits one physical batch', () => {
    // Regression: llama.cpp pools embeddings non-causally and cannot split an
    // input across physical batches. Without an explicit --ubatch-size it
    // defaults to 512 and rejects real chunks with HTTP 500 "input is too
    // large to process". Verified against llama-server b9402: a 1105-token
    // chunk returns 500 without these flags and 200 with them.
    const args = composeEmbeddingServerArgs(makeConfig());
    expect(argValue(args, '--ubatch-size')).toBe('2048');
    expect(argValue(args, '--batch-size')).toBe('2048');
    expect(argValue(args, '--ctx-size')).toBe('2048');
  });

  it('honours embeddings.n_ctx across ctx, batch and ubatch together', () => {
    const config = makeConfig({
      embeddings: { enabled: true, model_path: '/models/e.gguf', n_ctx: 4096 },
    });
    const args = composeEmbeddingServerArgs(config);
    expect(argValue(args, '--ctx-size')).toBe('4096');
    expect(argValue(args, '--batch-size')).toBe('4096');
    expect(argValue(args, '--ubatch-size')).toBe('4096');
  });

  it('does not inherit the chat model ctx/batch, which describe a different model', () => {
    const config = makeConfig({
      llama_server: { binary: '/bin/llama-server', default_num_ctx: 262144, n_batch: 512 },
    });
    const args = composeEmbeddingServerArgs(config);
    expect(argValue(args, '--ctx-size')).toBe('2048');
    expect(argValue(args, '--batch-size')).toBe('2048');
  });

  it('passes model path, embedding flag and configured port', () => {
    const config = makeConfig({
      embeddings: { enabled: true, model_path: '/models/e.gguf', port: 8099 },
    });
    const args = composeEmbeddingServerArgs(config);
    expect(args).toContain('--embedding');
    expect(argValue(args, '-m')).toBe('/models/e.gguf');
    expect(argValue(args, '--port')).toBe('8099');
  });

  it('pins the embedding server to embeddings.device only when configured', () => {
    expect(composeEmbeddingServerArgs(makeConfig())).not.toContain('--device');
    const config = makeConfig({
      embeddings: { enabled: true, model_path: '/models/e.gguf', device: 'CUDA2' },
    });
    expect(argValue(composeEmbeddingServerArgs(config), '--device')).toBe('CUDA2');
  });
});

describe('embeddingModelMatches', () => {
  it('matches equivalent normalized model paths', () => {
    expect(embeddingModelMatches('/models/../models/embed.gguf', '/models/embed.gguf')).toBe(true);
  });

  it('rejects a server running a different embedding model', () => {
    expect(embeddingModelMatches('/models/other.gguf', '/models/embed.gguf')).toBe(false);
  });
});

describe('EmbeddingBackend cold-start approval', () => {
  it('warns before starting a configured cold server', () => {
    const backend = new EmbeddingBackend(makeConfig({
      embeddings: {
        enabled: true,
        model_path: '/models/e.gguf',
        idle_timeout_ms: 60_000,
      },
    }));

    expect(backend.startApproval()?.detail).toContain('additional VRAM');
    expect(backend.startApproval()?.detail).toContain('60 seconds');
  });

  it('can disable the cold-start warning explicitly', () => {
    const backend = new EmbeddingBackend(makeConfig({
      embeddings: {
        enabled: true,
        model_path: '/models/e.gguf',
        confirm_on_start: false,
      },
    }));

    expect(backend.startApproval()).toBeUndefined();
  });
});

describe('EmbeddingBackend process lifecycle', () => {
  it('clears stale readiness after child exit and respawns on the next start', async () => {
    const backend = new EmbeddingBackend(makeConfig());
    await backend.start();
    expect(backend.isReady()).toBe(true);
    const firstProcess = spawnLlamaServer.mock.results[0]?.value as ChildProcess;

    firstProcess.emit('exit', 137, 'SIGKILL');

    expect(backend.isReady()).toBe(false);
    await backend.start();
    expect(spawnLlamaServer).toHaveBeenCalledTimes(2);
    expect(backend.isReady()).toBe(true);
    await backend.stop();
  });

  it('restarts an owned server when changed config alters spawn arguments', async () => {
    const backend = new EmbeddingBackend(makeConfig());
    await backend.start();
    const updated = makeConfig({
      embeddings: { enabled: true, model_path: '/models/embeddinggemma-300m.gguf', device: 'CUDA2' },
    });

    backend.applyForgeConfig(updated);
    await backend.start();

    expect(killLlamaProcess).toHaveBeenCalledTimes(1);
    expect(spawnLlamaServer).toHaveBeenCalledTimes(2);
    expect((spawnLlamaServer.mock.calls[1]?.[1] as string[])).toContain('CUDA2');
    await backend.stop();
  });

  it('drops an adopted server that stopped answering and spawns its own', async () => {
    probeHealthy.mockResolvedValueOnce(true);
    probeServedModel.mockResolvedValueOnce('/models/embeddinggemma-300m.gguf');
    const backend = new EmbeddingBackend(makeConfig());
    await backend.start();
    expect(spawnLlamaServer).not.toHaveBeenCalled();

    await backend.start();

    expect(spawnLlamaServer).toHaveBeenCalledTimes(1);
    expect(backend.isReady()).toBe(true);
    await backend.stop();
  });

  it('explains an in-flight request failure after child exit and says the next call restarts', async () => {
    const backend = new EmbeddingBackend(makeConfig());
    await backend.start();
    const child = spawnLlamaServer.mock.results[0]?.value as ChildProcess;
    child.emit('exit', 137, 'SIGKILL');

    await expect(backend.withActivity(async () => { throw new TypeError('fetch failed'); }))
      .rejects.toThrow(/embedding server exited.*restart automatically on the next semantic search.*fetch failed/i);
    await backend.stop();
  });
});
