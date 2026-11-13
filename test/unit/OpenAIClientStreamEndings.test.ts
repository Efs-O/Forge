import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../src/llm/types';
import { streamChatCompletion } from '../../src/llm/OpenAIClient';
import { ToolCallTruncatedError } from '../../src/llm/ToolCallTruncatedError';
import { preflightToolCall } from '../../src/sidebar/toolCallPreflight';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

const { logLines } = vi.hoisted(() => ({ logLines: [] as string[] }));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => logLines.push(line),
      show: () => {},
      dispose: () => {},
    }),
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
const CUT_ARGS = { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a' } }] };

async function run(lines: string[]) {
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(lines)));
  const h = handlers();
  await streamChatCompletion('http://x', request, h);
  return h;
}

afterEach(() => {
  vi.unstubAllGlobals();
  logLines.length = 0;
});

describe('every way a stream ends gets the same truncation check', () => {
  it('[DONE] raises truncation instead of dispatching the half-written call', async () => {
    const h = await run([chunk(CUT_ARGS), 'data: [DONE]']);
    expect(h.onToolCalls).not.toHaveBeenCalled();
    expect(h.onError.mock.calls[0]?.[0]).toBeInstanceOf(ToolCallTruncatedError);
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it('a stop finish raises it too, not only a length finish', async () => {
    const h = await run([chunk(CUT_ARGS), chunk({}, 'tool_calls'), 'data: [DONE]']);
    expect(h.onToolCalls).not.toHaveBeenCalled();
    expect(h.onError.mock.calls[0]?.[0]).toBeInstanceOf(ToolCallTruncatedError);
  });

  it('EOF raises it too', async () => {
    const h = await run([chunk(CUT_ARGS)]);
    expect(h.onToolCalls).not.toHaveBeenCalled();
    expect(h.onError.mock.calls[0]?.[0]).toBeInstanceOf(ToolCallTruncatedError);
  });

  it('a tool that takes no arguments still dispatches exactly once', async () => {
    const h = await run([
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_executions' } }] }),
      chunk({}, 'tool_calls'),
      'data: [DONE]',
    ]);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onToolCalls).toHaveBeenCalledOnce();
    expect(h.onToolCalls.mock.calls[0]?.[0]).toEqual([
      { id: 'c1', type: 'function', function: { name: 'list_executions', arguments: '' } },
    ]);

    // Delivered is not the same as runnable: the call has to get through
    // preflight, which is what decides whether it executes.
    const delivered = h.onToolCalls.mock.calls[0]?.[0] as ToolCall[];
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        type: 'function',
        function: {
          name: 'list_executions',
          description: 'List background runs',
          parameters: { type: 'object' },
        },
      },
      permission: 'read',
      handler: async () => 'listed',
    });
    const pre = preflightToolCall(delivered[0] as ToolCall, {
      toolRegistry: registry,
      allowed: new Set(['read']),
      convId: undefined,
      signal: undefined,
      budget: undefined,
      unavailableTools: undefined,
      clankerMode: false,
    });
    if (pre.kind !== 'ready') {
      throw new Error(`preflight refused the call: ${JSON.stringify(pre.result)}`);
    }
    expect(pre.args).toEqual({});
  });

  it('a terminal frame followed by [DONE] settles once, with no second dispatch', async () => {
    const h = await run([
      chunk({
        tool_calls: [
          { index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
      'data: [DONE]',
    ]);
    expect(h.onToolCalls).toHaveBeenCalledOnce();
    expect(h.onDone).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
  });
});

describe('content and reasoning are separate channels', () => {
  it('a delta carrying both emits both', async () => {
    const h = await run([
      chunk({ content: 'the answer', reasoning_content: 'the thinking' }),
      'data: [DONE]',
    ]);
    expect(h.onToken).toHaveBeenCalledWith('the answer');
    expect(h.onReasoning).toHaveBeenCalledWith('the thinking');
    expect(h.onToken).toHaveBeenCalledOnce();
    expect(h.onReasoning).toHaveBeenCalledOnce();
  });

  it('content alone stays content', async () => {
    const h = await run([chunk({ content: 'only text' }), 'data: [DONE]']);
    expect(h.onToken).toHaveBeenCalledWith('only text');
    expect(h.onReasoning).not.toHaveBeenCalled();
  });

  it('reasoning_content alone stays reasoning', async () => {
    const h = await run([chunk({ reasoning_content: 'only thinking' }), 'data: [DONE]']);
    expect(h.onReasoning).toHaveBeenCalledWith('only thinking');
    expect(h.onToken).not.toHaveBeenCalled();
  });

  it('the two reasoning spellings in one delta are alternatives, not both', async () => {
    const h = await run([
      chunk({ reasoning_content: 'same text', reasoning: 'same text' }),
      'data: [DONE]',
    ]);
    expect(h.onReasoning).toHaveBeenCalledOnce();
    expect(h.onReasoning).toHaveBeenCalledWith('same text');
  });

  it('a provider that spells it `reasoning` still reaches the reasoning channel', async () => {
    const h = await run([chunk({ reasoning: 'deep' }), 'data: [DONE]']);
    expect(h.onReasoning).toHaveBeenCalledWith('deep');
    expect(h.onToken).not.toHaveBeenCalled();
  });
});
