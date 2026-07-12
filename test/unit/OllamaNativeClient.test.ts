import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import { streamOllamaChatCompletion } from '../../src/llm/OllamaNativeClient';
import type { ChatCompletionRequest } from '../../src/llm/types';

const baseModel: ModelConfig = {
  name: 'qwen3.5:9b',
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  num_ctx: 262144,
  think: true,
  reasoning_effort: 'medium',
};

const baseRequest: ChatCompletionRequest = {
  model: 'qwen3.5:9b',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  min_p: 0.05,
  max_tokens: 1024,
  repeat_last_n: 64,
  repetition_penalty: 1.1,
  stop: ['<end>'],
};

describe('streamOllamaChatCompletion', () => {
  it('sends Ollama-native options and think controls', async () => {
    const lines = [
      JSON.stringify({ message: { thinking: 'plan ' }, done: false }),
      JSON.stringify({ message: { content: 'done' }, done: true, done_reason: 'stop' }),
    ].join('\n');
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(lines) })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read,
          releaseLock: vi.fn(),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const reasoning = vi.fn();
    const tokens = vi.fn();
    const done = vi.fn();

    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: tokens,
      onReasoning: reasoning,
      onDone: done,
      onError: (err) => {
        throw err;
      },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/chat', expect.any(Object));
    expect(body.model).toBe('qwen3.5:9b');
    expect(body.think).toBe('medium');
    expect(body.options).toMatchObject({
      num_ctx: 262144,
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.05,
      num_predict: 1024,
      repeat_last_n: 64,
      repeat_penalty: 1.1,
      stop: ['<end>'],
    });
    expect(reasoning).toHaveBeenCalledWith('plan ');
    expect(tokens).toHaveBeenCalledWith('done');
    expect(done).toHaveBeenCalledWith('stop');
    vi.unstubAllGlobals();
  });

  it('submits an unlisted cloud alias exactly and tolerates a normalized response model', async () => {
    const cloudId = 'qwen3-coder:480b-cloud';
    const line = JSON.stringify({
      model: 'qwen3-coder:480b',
      message: { content: 'ok' },
      done: true,
      done_reason: 'stop',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new Response(`${line}\n`).body,
    });
    vi.stubGlobal('fetch', fetchMock);

    const done = vi.fn();
    await streamOllamaChatCompletion(
      'http://127.0.0.1:11434',
      { ...baseRequest, model: cloudId },
      { ...baseModel, name: cloudId },
      { onToken: vi.fn(), onDone: done, onError: vi.fn(), onToolCalls: vi.fn() },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ model: cloudId });
    expect(done).toHaveBeenCalledWith('stop');
    vi.unstubAllGlobals();
  });
});
