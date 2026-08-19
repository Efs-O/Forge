import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChatCompletion } from '../../src/llm/OpenAIClient';

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

describe('streamed tool-call names', () => {
  it('does not double a name the provider repeats on every delta', async () => {
    // Measured on gemma4:31b-cloud: the name came back on each chunk, and
    // appending produced "search_codesearch_code" — dispatched as an unknown
    // tool, so the round was spent for nothing.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_code' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { name: 'search_code', arguments: '{"query"' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { name: 'search_code', arguments: ':"x"}' } }] }),
          chunk({}, 'tool_calls'),
          'data: [DONE]',
        ]),
      ),
    );
    const h = handlers();
    await streamChatCompletion('http://localhost:0', request as never, h);
    expect(h.onToolCalls).toHaveBeenCalledTimes(1);
    const calls = h.onToolCalls.mock.calls[0]?.[0] as { function: { name: string; arguments: string } }[];
    expect(calls[0]?.function.name).toBe('search_code');
    expect(calls[0]?.function.arguments).toBe('{"query":"x"}');
  });

  it('still joins a name delivered in genuine fragments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'search' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { name: '_codebase', arguments: '{}' } }] }),
          chunk({}, 'tool_calls'),
          'data: [DONE]',
        ]),
      ),
    );
    const h = handlers();
    await streamChatCompletion('http://localhost:0', request as never, h);
    const calls = h.onToolCalls.mock.calls[0]?.[0] as { function: { name: string } }[];
    expect(calls[0]?.function.name).toBe('search_codebase');
  });

  it('keeps separate indices separate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'search_code', arguments: '{}' } }] }),
          chunk({}, 'tool_calls'),
          'data: [DONE]',
        ]),
      ),
    );
    const h = handlers();
    await streamChatCompletion('http://localhost:0', request as never, h);
    const calls = h.onToolCalls.mock.calls[0]?.[0] as { function: { name: string } }[];
    expect(calls.map((c) => c.function.name)).toEqual(['read_file', 'search_code']);
  });
});
