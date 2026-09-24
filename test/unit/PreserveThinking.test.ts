import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachCurrentTaskReasoning,
  dropOldestReasoning,
  preservesThinking,
} from '../../src/agent/preserveThinking';
import { prepareToolResultContext } from '../../src/agent/toolResultContext';
import { streamChatCompletion } from '../../src/llm/OpenAIClient';
import type { ChatCompletionRequest, ChatMessage } from '../../src/llm/types';
import { estimateTokens } from '../../src/util/contextBudget';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

afterEach(() => vi.unstubAllGlobals());

const call = (id: string) => [
  { id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } },
];

function task(): ChatMessage[] {
  return [
    { role: 'user', content: 'old task' },
    { role: 'assistant', content: 'done', reasoning: 'OLD TASK THINKING' },
    { role: 'user', content: 'refactor foo.ts' },
    { role: 'assistant', content: null, tool_calls: call('a'), reasoning: '  Round one:\nread it.  ' },
    { role: 'tool', tool_call_id: 'a', content: 'file body' },
    { role: 'user', content: 'also fix bar', midTurn: true },
    { role: 'assistant', content: null, tool_calls: call('b'), reasoning: 'Round two.' },
    { role: 'tool', tool_call_id: 'b', content: 'ok' },
    { role: 'user', content: 'nudge', internal: true },
    { role: 'assistant', content: null, tool_calls: call('c'), reasoning: '   ' },
  ];
}

describe('preserve_thinking', () => {
  it('is on only for a llama.cpp model with the flag explicitly true', () => {
    expect(preservesThinking({ name: 'q', sampling: { preserve_thinking: true } } as never)).toBe(true);
    expect(
      preservesThinking({ name: 'q', provider: 'llama.cpp', sampling: { preserve_thinking: true } } as never),
    ).toBe(true);
    expect(preservesThinking({ name: 'q' } as never)).toBe(false);
    expect(preservesThinking({ name: 'q', sampling: { preserve_thinking: false } } as never)).toBe(false);
    expect(
      preservesThinking({ name: 'q', provider: 'openrouter', sampling: { preserve_thinking: true } } as never),
    ).toBe(false);
  });

  it('sends back only the current task, verbatim, across mid-turn and internal messages', () => {
    const messages = task();
    const out = attachCurrentTaskReasoning(messages);
    expect(out[1]?.reasoning_content).toBeUndefined();
    // Byte-for-byte, whitespace included: a trimmed copy would miss the KV cache.
    expect(out[3]?.reasoning_content).toBe('  Round one:\nread it.  ');
    expect(out[6]?.reasoning_content).toBe('Round two.');
    expect(out[9]?.reasoning_content).toBeUndefined();
    // The stored transcript is never touched.
    expect(messages.some((m) => m.reasoning_content !== undefined)).toBe(false);
  });

  it('counts sent reasoning in the estimate, and never the sidebar-only copy', () => {
    const thinking = 'x'.repeat(3100);
    const sidebarOnly: ChatMessage[] = [{ role: 'assistant', content: 'hi', reasoning: thinking }];
    const sent: ChatMessage[] = [{ ...sidebarOnly[0]!, reasoning_content: thinking }];
    expect(estimateTokens(sent) - estimateTokens(sidebarOnly)).toBe(1000);
  });

  it('drops the oldest reasoning first', () => {
    const out = attachCurrentTaskReasoning(task());
    const trimmed = dropOldestReasoning(
      out,
      (m) => m.filter((x) => x.reasoning_content !== undefined).length <= 1,
    );
    expect(trimmed[3]?.reasoning_content).toBeUndefined();
    expect(trimmed[6]?.reasoning_content).toBe('Round two.');
  });

  it('gives up thinking before it excerpts any tool result', () => {
    const model = { name: 'local', num_ctx: 12_000 } as never;
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: call('a'), reasoning_content: 'r'.repeat(20_000) },
      { role: 'tool', tool_call_id: 'a', content: 't'.repeat(8_000) },
    ];
    const result = prepareToolResultContext({ messages, toolTokens: 0, model });
    expect(result.fits).toBe(true);
    expect(result.excerptedToolCallIds).toEqual([]);
    expect(result.messages[1]?.reasoning_content).toBeUndefined();
    expect(result.messages[2]?.content).toBe(messages[2]?.content);
  });

  it('puts reasoning_content on the wire when the model-facing copy carries it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('data: [DONE]\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      model: 'q',
      stream: true,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: call('a'), reasoning: 'T', reasoning_content: 'T' },
        { role: 'assistant', content: 'x', reasoning: 'sidebar only' },
      ],
    } as unknown as ChatCompletionRequest;
    await streamChatCompletion('http://localhost:0', request, {
      onToken: vi.fn(),
      onReasoning: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onToolCalls: vi.fn(),
    });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.messages[1].reasoning_content).toBe('T');
    expect(body.messages[1].reasoning).toBeUndefined();
    expect(body.messages[2].reasoning_content).toBeUndefined();
  });
});
