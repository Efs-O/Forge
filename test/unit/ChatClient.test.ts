import { describe, expect, it, vi } from 'vitest';
import { CLI_MODEL_CHAT_ERROR, streamModelChatCompletion } from '../../src/llm/ChatClient';
import type { ModelConfig } from '../../src/config/types';

describe('streamModelChatCompletion provider: cli', () => {
  it('reports a clear structured error instead of dispatching an HTTP request', async () => {
    const onError = vi.fn();
    const model: ModelConfig = { name: 'claude-code', provider: 'cli', cli: 'claude' };
    await streamModelChatCompletion(
      'http://127.0.0.1:8080',
      { model: 'claude-code', messages: [], stream: true },
      model,
      {
        onToken: vi.fn(),
        onReasoning: vi.fn(),
        onToolCalls: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toBe(CLI_MODEL_CHAT_ERROR);
  });
});

const localFetch = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm/localLlamaFetch', () => ({ localLlamaFetch: localFetch }));

describe('streamModelChatCompletion headers-timeout routing', () => {
  const sse = () =>
    new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  const handlers = () => ({ onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() });

  async function route(model: ModelConfig): Promise<'local' | 'global'> {
    localFetch.mockReset().mockImplementation(async () => sse());
    const globalFetch = vi.fn(async () => sse());
    vi.stubGlobal('fetch', globalFetch);
    const h = handlers();
    await streamModelChatCompletion(
      'http://127.0.0.1:8080',
      { model: model.name, messages: [], stream: true },
      model,
      h,
    );
    vi.unstubAllGlobals();
    expect(h.onError).not.toHaveBeenCalled();
    expect(localFetch.mock.calls.length + globalFetch.mock.calls.length).toBe(1);
    return localFetch.mock.calls.length === 1 ? 'local' : 'global';
  }

  it('sends local llama.cpp requests through the long-wait fetch', async () => {
    expect(await route({ name: 'q', provider: 'llama.cpp' })).toBe('local');
    expect(await route({ name: 'q' })).toBe('local');
  });

  it('leaves every cloud provider on the extension host fetch', async () => {
    for (const provider of ['xai', 'openrouter', 'openai', 'openai-compatible'] as const) {
      expect(await route({ name: 'c', provider })).toBe('global');
    }
  });
});
