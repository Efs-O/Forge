import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { StreamHandlers } from '../../src/llm/OpenAIClient';
import { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import { CLOUD_DELEGATION_TIMEOUT_MS } from '../../src/delegation/limits';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: path.resolve('/workspace') } }] },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

const root = path.resolve('/workspace');

function model(name: string, provider: ModelConfig['provider'], extra: Partial<ModelConfig> = {}) {
  return { name, provider, ...extra } as ModelConfig;
}

function config(): ForgeConfig {
  return {
    models: [
      { name: 'llama', provider: 'llama.cpp', gguf_path: '/llama.gguf' },
      model('openrouter-model', 'openrouter', { api_key_secret: 'openrouter' }),
      model('compat-model', 'openai-compatible', {
        endpoint: 'https://api.cerebras.ai/v1',
        api_key_secret: 'cerebras',
      }),
    ],
    active_model: 'llama',
    llama_server: {},
  };
}

interface CloudHarness {
  service: LocalDelegationService;
  streamChat: ReturnType<typeof vi.fn>;
  canDelegate: ReturnType<typeof vi.fn>;
  acquireForDelegation: ReturnType<typeof vi.fn>;
  timeouts: number[];
  timeout: AbortController;
}

function makeHarness(
  opts: Partial<{ secret: string | undefined; streamNever: boolean }> = {},
): CloudHarness {
  const timeout = new AbortController();
  const timeouts: number[] = [];
  const canDelegate = vi.fn().mockReturnValue({ safe: true });
  const acquireForDelegation = vi.fn();
  const streamChat = vi.fn((_base, _req, _model, handlers: StreamHandlers, signal) => {
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (opts.streamNever) return;
      handlers.onToken('cloud analysis');
      handlers.onDone('stop');
      _resolve();
    });
  });
  const service = new LocalDelegationService({
    getConfig: config,
    workspaceRoot: root,
    backendPool: { canDelegate, acquireForDelegation },
    statFile: vi.fn().mockResolvedValue({ size: 3, isFile: true }),
    readFile: vi.fn().mockResolvedValue(new TextEncoder().encode('abc')),
    realPath: (filePath: string) => Promise.resolve(filePath),
    makeTimeoutSignal: (ms: number) => {
      timeouts.push(ms);
      return timeout.signal;
    },
    streamChat,
    secrets: {
      get: vi.fn().mockResolvedValue('secret' in opts ? opts.secret : 'sk-test'),
      store: vi.fn(),
      delete: vi.fn(),
      onDidChange: vi.fn(),
    } as never,
  });
  return { service, streamChat, canDelegate, acquireForDelegation, timeouts, timeout };
}

describe('LocalDelegationService cloud targets', () => {
  it('streams to the provider base URL with the stored bearer token', async () => {
    const h = makeHarness();
    const result = await h.service.ask({
      primaryModel: 'llama',
      targetModel: 'openrouter-model',
      task: 'second opinion',
    });

    expect(result.text).toBe('cloud analysis');
    expect(result.targetModel).toBe('openrouter-model');
    expect(result.bestEffort).toBe(false);
    const [baseUrl, , targetModel, , , apiKey] = h.streamChat.mock.calls[0];
    expect(baseUrl).toBe('https://openrouter.ai/api');
    expect((targetModel as ModelConfig).name).toBe('openrouter-model');
    expect(apiKey).toBe('sk-test');
  });

  it('normalises an openai-compatible endpoint to its base', async () => {
    const h = makeHarness();
    await h.service.ask({
      primaryModel: 'llama',
      targetModel: 'compat-model',
      task: 'check',
    });
    expect(h.streamChat.mock.calls[0][0]).toBe('https://api.cerebras.ai');
  });

  // A cloud target holds no local slot; gating it on pool capacity would fail
  // the consultation exactly when the local slot is busy.
  it('never touches the backend pool', async () => {
    const h = makeHarness();
    await h.service.ask({
      primaryModel: 'llama',
      targetModel: 'openrouter-model',
      task: 'check',
    });
    expect(h.acquireForDelegation).not.toHaveBeenCalled();
    expect(h.canDelegate).not.toHaveBeenCalled();
    expect(h.service.canDelegate('llama', 'openrouter-model')).toEqual({ ok: true });
  });

  it('uses the longer cloud timeout, not the 120s local one', async () => {
    const h = makeHarness();
    await h.service.ask({
      primaryModel: 'llama',
      targetModel: 'openrouter-model',
      task: 'check',
    });
    expect(h.timeouts).toEqual([CLOUD_DELEGATION_TIMEOUT_MS]);
  });

  it('surfaces a missing SecretStorage token instead of falling back', async () => {
    const h = makeHarness({ secret: undefined });
    await expect(
      h.service.ask({ primaryModel: 'llama', targetModel: 'openrouter-model', task: 'check' }),
    ).rejects.toThrow('no bearer token in SecretStorage');
    expect(h.streamChat).not.toHaveBeenCalled();
  });

  it('reports a timeout abort as a timeout', async () => {
    const h = makeHarness({ streamNever: true });
    const promise = h.service.ask({
      primaryModel: 'llama',
      targetModel: 'openrouter-model',
      task: 'check',
    });
    const rejected = expect(promise).rejects.toThrow(
      `Delegation timeout: exceeded ${CLOUD_DELEGATION_TIMEOUT_MS}ms.`,
    );
    await Promise.resolve();
    h.timeout.abort(new DOMException('timeout', 'TimeoutError'));
    await rejected;
  });

  it('reports a caller abort as a cancellation', async () => {
    const h = makeHarness({ streamNever: true });
    const caller = new AbortController();
    const promise = h.service.ask({
      primaryModel: 'llama',
      targetModel: 'openrouter-model',
      task: 'check',
      signal: caller.signal,
    });
    const rejected = expect(promise).rejects.toThrow('Delegation cancelled by caller.');
    await Promise.resolve();
    caller.abort(new DOMException('cancelled', 'AbortError'));
    await rejected;
  });
});
