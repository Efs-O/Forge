import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { StreamHandlers } from '../../src/llm/OpenAIClient';
import { streamModelChatCompletion } from '../../src/llm/ChatClient';

// Mock the streaming client: drive whatever handlers the proxy passes.
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion: vi.fn() }));
// xAI token resolution would otherwise touch the filesystem.
vi.mock('../../src/llm/XaiAuth', () => ({ resolveXaiToken: async () => 'xai-token' }));

import { buildControlChatProxy, ProxyError } from '../../src/llm/ControlChatProxy';

const streamMock = vi.mocked(streamModelChatCompletion);
/** streamModelChatCompletion(baseUrl, request, model, handlers, signal, apiKey) */
const handlersOf = (args: unknown[]): StreamHandlers => args[3] as StreamHandlers;

function config(): ForgeConfig {
  return {
    models: [
      { name: 'grok', provider: 'xai', api_key_secret: 'forge.xai' },
      { name: 'router', provider: 'openrouter', api_key_secret: 'forge.or' },
      { name: 'local', provider: 'llama.cpp', gguf_path: '/l.gguf' },
    ],
    active_model: 'grok',
    llama_server: {},
  } as ForgeConfig;
}

const secrets = { get: async (k: string) => (k === 'forge.or' ? 'or-key' : undefined) } as never;

describe('buildControlChatProxy', () => {
  beforeEach(() => {
    streamMock.mockReset();
  });

  it('buffers streamed tokens + reasoning and surfaces finish_reason', async () => {
    streamMock.mockImplementation(async (...args: unknown[]) => {
      const h = handlersOf(args);
      h.onReasoning?.('think ');
      h.onToken('Hello ');
      h.onToken('world');
      h.onDone('stop');
    });
    const proxy = buildControlChatProxy(config, secrets);
    const out = await proxy({ model: 'router', messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toEqual({ content: 'Hello world', reasoning: 'think ', finishReason: 'stop' });
  });

  it('passes the resolved xAI key + cloud baseUrl to the client', async () => {
    streamMock.mockImplementation(async (...args: unknown[]) => handlersOf(args).onDone('stop'));
    const proxy = buildControlChatProxy(config, secrets);
    await proxy({ model: 'grok', messages: [{ role: 'user', content: 'hi' }] });
    const [baseUrl, , , , , apiKey] = streamMock.mock.calls[0];
    expect(baseUrl).toBe('https://api.x.ai');
    expect(apiKey).toBe('xai-token');
  });

  it('rejects a local model with ProxyError(422)', async () => {
    const proxy = buildControlChatProxy(config, secrets);
    await expect(proxy({ model: 'local', messages: [] })).rejects.toMatchObject({
      status: 422,
    });
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('404s an unknown model and 422s a missing key', async () => {
    const proxy = buildControlChatProxy(config, secrets);
    await expect(proxy({ model: 'nope', messages: [] })).rejects.toBeInstanceOf(ProxyError);
    await expect(proxy({ model: 'nope', messages: [] })).rejects.toMatchObject({ status: 404 });

    const noKey = { get: async () => undefined } as never;
    const proxy2 = buildControlChatProxy(config, noKey);
    await expect(proxy2({ model: 'router', messages: [] })).rejects.toMatchObject({ status: 422 });
  });

  it('rejects when the stream errors', async () => {
    streamMock.mockImplementation(async (...args: unknown[]) =>
      handlersOf(args).onError(new Error('upstream 500')),
    );
    const proxy = buildControlChatProxy(config, secrets);
    await expect(proxy({ model: 'router', messages: [] })).rejects.toThrow('upstream 500');
  });
});
