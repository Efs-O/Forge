import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChatCompletion } from '../../src/llm/OpenAIClient';
import type { ChatCompletionRequest } from '../../src/llm/types';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

function doneResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compat wire messages', () => {
  it('strips sidebar-only fields that strict validators (Cerebras) reject', async () => {
    // Regression: Cerebras answered HTTP 400 wrong_api_format —
    // `messages.2.assistant.reasoningMs: property ... is unsupported` — because
    // Forge sent its full ChatMessage objects, bookkeeping fields and all.
    const fetchMock = vi.fn(async () => doneResponse());
    vi.stubGlobal('fetch', fetchMock);

    const request = {
      model: 'qwen3.8-27b',
      stream: true,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'answer',
          reasoning: 'internal chain of thought',
          reasoningMs: 1234,
          internal: true,
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'file body', tool_call_id: 't1', name: 'read_file', toolMs: 42 },
      ],
    } as unknown as ChatCompletionRequest;

    await streamChatCompletion('http://localhost:0', request, handlers());

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('reasoningMs');
    expect(serialized).not.toContain('toolMs');
    expect(serialized).not.toContain('reasoning');
    expect(serialized).not.toContain('internal');

    // Wire fields survive intact.
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: 'answer',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    });
    expect(body.messages[3]).toEqual({
      role: 'tool',
      content: 'file body',
      tool_call_id: 't1',
      name: 'read_file',
    });
    // The request must not be mutated in place.
    expect((request.messages[2] as { reasoningMs?: number }).reasoningMs).toBe(1234);
  });
});
