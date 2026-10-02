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
  it('uses an explicit recovery think=false override', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: new Response(`${JSON.stringify({ done: true })}\n`).body });
    vi.stubGlobal('fetch', fetchMock);
    await streamOllamaChatCompletion('http://127.0.0.1:11434', { ...baseRequest, think: false }, baseModel, {
      onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).think).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects incomplete tool arguments when EOF arrives without a done frame', async () => {
    const line = JSON.stringify({ message: { tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a' } }] } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: new Response(`${line}\n`).body }));
    const onToolCalls = vi.fn();
    const onError = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(), onDone: vi.fn(), onError, onToolCalls,
    });
    expect(onToolCalls).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/incomplete|ended/u) }));
    vi.unstubAllGlobals();
  });

  it('handles an error in the trailing unterminated frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: new Response('{"error":"trailing failure"}').body }));
    const onError = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(), onDone: vi.fn(), onError,
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'trailing failure' }));
    vi.unstubAllGlobals();
  });

  it('keeps identical whole calls at the same index when they share one frame', async () => {
    const line = JSON.stringify({ message: { tool_calls: [
      { function: { index: 0, name: 'read_file', arguments: { path: 'same' } } },
      { function: { index: 0, name: 'read_file', arguments: { path: 'same' } } },
    ] }, done: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: new Response(`${line}\n`).body }));
    const onToolCalls = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onToolCalls,
    });
    expect(onToolCalls.mock.calls[0]?.[0]).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('keeps an identical whole payload across frames as a retransmission', async () => {
    const payload = { function: { index: 0, name: 'read_file', arguments: { path: 'same' } } };
    const lines = [
      JSON.stringify({ message: { tool_calls: [payload] }, done: false }),
      JSON.stringify({ message: { tool_calls: [payload] }, done: false }),
      JSON.stringify({ done: true }),
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: new Response(`${lines}\n`).body }));
    const onToolCalls = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onToolCalls,
    });
    expect(onToolCalls.mock.calls[0]?.[0]).toHaveLength(1);
    vi.unstubAllGlobals();
  });

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

  it('forwards Ollama token counters as OpenAI-shaped usage', async () => {
    // Ollama has no stream_options.include_usage; the counts ride the final
    // frame. Without this every context display reads 0 forever on Ollama,
    // because none of them will substitute an estimate.
    const line = JSON.stringify({
      message: { content: 'ok' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 1200,
      eval_count: 34,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: new Response(`${line}
`).body });
    vi.stubGlobal('fetch', fetchMock);

    const usage = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onToolCalls: vi.fn(),
      onUsage: usage,
    });

    expect(usage).toHaveBeenCalledWith({
      prompt_tokens: 1200,
      completion_tokens: 34,
      total_tokens: 1234,
    });
    vi.unstubAllGlobals();
  });

  it('reports no usage when the final frame omits the counters', async () => {
    const line = JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: 'stop' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: new Response(`${line}
`).body });
    vi.stubGlobal('fetch', fetchMock);

    const usage = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onToolCalls: vi.fn(),
      onUsage: usage,
    });

    expect(usage).not.toHaveBeenCalled();
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

  it('does not double a tool name repeated across frames', async () => {
    // A provider that repeats the name on every frame used to accumulate
    // "search_codesearch_code" — an unknown tool, and a wasted round.
    const lines = [
      JSON.stringify({
        message: { tool_calls: [{ function: { name: 'search_code', arguments: {} } }] },
        done: false,
      }),
      JSON.stringify({
        message: {
          tool_calls: [{ function: { name: 'search_code', arguments: { query: 'x' } } }],
        },
        done: false,
      }),
      JSON.stringify({ done: true, done_reason: 'stop' }),
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new Response(`${lines}\n`).body,
    });
    vi.stubGlobal('fetch', fetchMock);

    const toolCalls = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onToolCalls: toolCalls,
    });

    const calls = toolCalls.mock.calls[0]![0];
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('search_code');
    expect(calls[0].function.arguments).toBe('{"query":"x"}');
    vi.unstubAllGlobals();
  });

  it('keeps two tool calls that arrive at index 0 in separate frames', async () => {
    // Ollama has emitted every tool call of a multi-call response at index 0
    // (ollama/ollama#15457, #16212). Keying on index alone merged them into one
    // unparseable call and the second tool never ran.
    const lines = [
      JSON.stringify({
        message: {
          tool_calls: [{ function: { index: 0, name: 'read_file', arguments: { path: 'a.ts' } } }],
        },
        done: false,
      }),
      JSON.stringify({
        message: {
          tool_calls: [{ function: { index: 0, name: 'read_file', arguments: { path: 'b.ts' } } }],
        },
        done: false,
      }),
      JSON.stringify({ done: true, done_reason: 'stop' }),
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new Response(`${lines}\n`).body,
    });
    vi.stubGlobal('fetch', fetchMock);

    const toolCalls = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onToolCalls: toolCalls,
    });

    const calls = toolCalls.mock.calls[0]![0];
    expect(calls).toHaveLength(2);
    expect(calls.map((c: { function: { arguments: string } }) => c.function.arguments)).toEqual([
      '{"path":"a.ts"}',
      '{"path":"b.ts"}',
    ]);
    vi.unstubAllGlobals();
  });

  it('still concatenates argument fragments for one call', async () => {
    // The name-repeat guard must not break genuine fragmentation: a string
    // argument arriving in pieces belongs to the call already in that slot.
    const lines = [
      JSON.stringify({
        message: { tool_calls: [{ function: { index: 0, name: 'write_file', arguments: '{"pa' } }] },
        done: false,
      }),
      JSON.stringify({
        message: { tool_calls: [{ function: { index: 0, arguments: 'th":"a.ts"}' } }] },
        done: false,
      }),
      JSON.stringify({ done: true, done_reason: 'stop' }),
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new Response(`${lines}\n`).body,
    });
    vi.stubGlobal('fetch', fetchMock);

    const toolCalls = vi.fn();
    await streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onToolCalls: toolCalls,
    });

    const calls = toolCalls.mock.calls[0]![0];
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('write_file');
    expect(calls[0].function.arguments).toBe('{"path":"a.ts"}');
    vi.unstubAllGlobals();
  });

  it('aborts an Ollama stream that goes silent after its first frame', async () => {
    // The Ollama route had no idle budget: a model that wedged mid-stream left
    // the turn hanging with no tokens, no error, and no way out but a restart.
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let push: ((line: string) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line) => controller.enqueue(encoder.encode(`${line}\n`));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body })));

    const tokens = vi.fn();
    const done = vi.fn();
    const onError = vi.fn();
    const running = streamOllamaChatCompletion('http://127.0.0.1:11434', baseRequest, baseModel, {
      onToken: tokens,
      onDone: done,
      onError,
    });

    // Silence before the first byte is prefill, not a stall: the longer budget
    // applies, so 300 s of thinking must stay alive.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(onError).not.toHaveBeenCalled();

    push?.(JSON.stringify({ message: { content: 'partial' }, done: false }));
    await vi.advanceTimersByTimeAsync(135_000);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Stream stalled after 120s idle' }),
    );
    // A stall is an error, never a silent completion of the turn.
    expect(done).not.toHaveBeenCalled();
    await running;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
