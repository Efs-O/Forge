import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChatCompletion } from '../../src/llm/OpenAIClient';
import { ToolCallTruncatedError } from '../../src/llm/ToolCallTruncatedError';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function chunk(delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'x',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}`;
}

function handlers() {
  return {
    onToken: vi.fn(),
    onReasoning: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onToolCalls: vi.fn(),
  };
}

const request = { model: 'm', messages: [], stream: true } as const;

afterEach(() => vi.unstubAllGlobals());

describe('OpenAIClient truncation handling', () => {
  it('raises truncation instead of dispatching a half-written tool call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"ui.js","con' } }] }),
          chunk({}, 'length'),
        ]),
      ),
    );
    const h = handlers();
    await streamChatCompletion('http://x', request, h);

    // Flushing this was how an empty {} reached the dispatcher and got
    // reported as malformed.
    expect(h.onToolCalls).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledOnce();
    const err = h.onError.mock.calls[0]![0] as ToolCallTruncatedError;
    expect(err).toBeInstanceOf(ToolCallTruncatedError);
    expect(err.toolName).toBe('write_file');
    expect(err.toolCallId).toBe('c1');
  });

  it('still dispatches complete arguments that finish on length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({
            tool_calls: [
              { index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } },
            ],
          }),
          chunk({}, 'length'),
        ]),
      ),
    );
    const h = handlers();
    await streamChatCompletion('http://x', request, h);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onToolCalls).toHaveBeenCalledOnce();
  });

  it('reads final usage after the terminal choice before settling the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({ content: 'done' }, 'stop'),
          `data: ${JSON.stringify({
            id: 'x',
            object: 'chat.completion.chunk',
            choices: [],
            usage: { prompt_tokens: 36704, completion_tokens: 209, total_tokens: 36913 },
          })}`,
          'data: [DONE]',
        ]),
      ),
    );
    const h = { ...handlers(), onUsage: vi.fn() };
    await streamChatCompletion('http://x', request, h);
    expect(h.onUsage).toHaveBeenCalledWith({
      prompt_tokens: 36704,
      completion_tokens: 209,
      total_tokens: 36913,
    });
    expect(h.onDone).toHaveBeenCalledWith('stop');
  });

  it('surfaces a mid-stream error frame instead of ending in silence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({ content: 'thinking' }),
          `data: ${JSON.stringify({ error: { code: 500, message: 'kv cache is full' } })}`,
        ]),
      ),
    );
    const h = handlers();
    await streamChatCompletion('http://x', request, h);
    expect(h.onError).toHaveBeenCalledOnce();
    expect((h.onError.mock.calls[0]![0] as Error).message).toBe('kv cache is full');
  });

  it('reads an error frame delivered on an error: line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([`error: ${JSON.stringify({ error: { message: 'slot unavailable' } })}`]),
      ),
    );
    const h = handlers();
    await streamChatCompletion('http://x', request, h);
    expect(h.onError).toHaveBeenCalledOnce();
    expect((h.onError.mock.calls[0]![0] as Error).message).toBe('slot unavailable');
  });

  it('types a truncation 500 body so the caller retries smaller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '{"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: parse error at line 1, column 10509: invalid string: missing closing quote"}}',
            { status: 500 },
          ),
      ),
    );
    const h = handlers();
    await streamChatCompletion('http://x', request, h);
    const err = h.onError.mock.calls[0]![0] as ToolCallTruncatedError;
    expect(err).toBeInstanceOf(ToolCallTruncatedError);
    expect(err.approxBytes).toBe(10509);
  });

  it('leaves an ordinary HTTP failure as a plain error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('model not found', { status: 404 })),
    );
    const h = handlers();
    await streamChatCompletion('http://x', request, h);
    const err = h.onError.mock.calls[0]![0] as Error;
    expect(err).not.toBeInstanceOf(ToolCallTruncatedError);
    expect(err.message).toContain('404');
  });
});
