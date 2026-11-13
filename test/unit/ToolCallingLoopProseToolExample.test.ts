import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, ChatMessage, ToolCall } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';

interface Handlers {
  onToken: (t: string) => void;
  onReasoning: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onError: (err: unknown) => void;
}

/** A tool example inside an explanation — the shape the audit called F1. */
const PROSE_EXAMPLE = [
  'Here is how I would fix it:',
  '',
  '```json',
  '{"tool": "write_file", "arguments": {"path": "notes.md", "content": "hi"}}',
  '```',
  '',
  'That would overwrite the file.',
].join('\n');

/** A call the model wrote in text because its backend never emits native ones. */
const MARKER_CALL =
  'Reading it.\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>';

function scripted(texts: string[], failFirst?: string): ChatCompletionRequest[] {
  const sent: ChatCompletionRequest[] = [];
  let round = 0;
  let failedOnce = false;
  streamModelChatCompletion.mockImplementation(
    async (_url: string, req: ChatCompletionRequest, _model: unknown, h: Handlers) => {
      sent.push(req);
      if (failFirst && !failedOnce) {
        failedOnce = true;
        h.onError(new Error(failFirst));
        return;
      }
      h.onToken(texts[round++] ?? 'Done.');
      h.onDone('stop');
    },
  );
  return sent;
}

async function run(
  texts: string[],
  opts: { nativeTools: boolean; model?: Record<string, unknown>; failFirst?: string },
): Promise<{
  sent: ChatCompletionRequest[];
  visible: string;
  dispatched: ToolCall[][];
  messages: ChatMessage[];
}> {
  const visible: string[] = [];
  const dispatched: ToolCall[][] = [];
  const sent = scripted(texts, opts.failFirst);
  const messages = [{ role: 'user', content: 'how would you fix it?' }] as ChatMessage[];
  await runToolCallingLoop({
    resolveBaseUrl: async () => 'http://localhost:0',
    model: { name: 'test-model', ...(opts.model ?? {}) } as never,
    messages,
    getToolDefinitions: () =>
      [
        {
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
        },
        {
          type: 'function',
          function: { name: 'write_file', parameters: { type: 'object', properties: {} } },
        },
      ] as never,
    dispatchToolCalls: async (calls: ToolCall[]) => {
      dispatched.push(calls);
    },
    onToken: (token: string) => {
      visible.push(token);
    },
    signal: new AbortController().signal,
    maxRounds: 3,
    nativeTools: opts.nativeTools,
  } as never);
  return { sent, visible: visible.join(''), dispatched, messages };
}

/** What the transcript keeps as this turn's answer. */
function answer(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content ?? '')
    .join('\n');
}

describe('a tool example in prose (audit F1)', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  it('runs no tool when the round offered native tools', async () => {
    const { dispatched, messages } = await run([PROSE_EXAMPLE], { nativeTools: true });
    expect(dispatched).toEqual([]);
    // The example is the answer the user asked for, so it stays in the transcript.
    expect(answer(messages)).toContain('```json');
    expect(answer(messages)).toContain('That would overwrite the file.');
  });

  it('still runs a call the model wrote in text when the round had no native tools', async () => {
    const { dispatched, messages } = await run([PROSE_EXAMPLE], { nativeTools: false });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.[0]?.function.name).toBe('write_file');
    expect(JSON.parse(dispatched[0]?.[0]?.function.arguments ?? '{}')).toEqual({
      path: 'notes.md',
      content: 'hi',
    });
    // A call that ran is hidden from the kept answer, exactly as before.
    expect(answer(messages)).not.toContain('```json');
  });

  it('runs the fenced form for a model that says its backend ignores native tools', async () => {
    const { dispatched } = await run([PROSE_EXAMPLE], {
      nativeTools: true,
      model: { text_tool_calls: 'text' },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.[0]?.function.name).toBe('write_file');
  });

  it('runs nothing from text for a model that wants native events only', async () => {
    const { dispatched, visible } = await run([MARKER_CALL], {
      nativeTools: false,
      model: { text_tool_calls: 'native' },
    });
    expect(dispatched).toEqual([]);
    expect(visible).toContain('<tool_call>');
  });

  it('still runs a text call a native backend leaked as markers', async () => {
    const { dispatched, messages } = await run([MARKER_CALL], { nativeTools: true });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.[0]?.function.name).toBe('read_file');
    expect(answer(messages)).not.toContain('<tool_call>');
  });

  // The recovery round sends no native tools and does send the fenced-JSON
  // instructions, so the fence is its only channel whatever the model's
  // `text_tool_calls` default is. A native round that reads no fence must not
  // leave this one reading none too.
  it('reads the fence again after a native tool call fails to parse', async () => {
    const { sent, dispatched } = await run([PROSE_EXAMPLE], {
      nativeTools: true,
      failFirst: 'HTTP 500: Failed to parse tool call arguments as JSON',
    });
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0]?.tools).toBeDefined();
    expect(sent[1]?.tools).toBeUndefined();
    expect(String(sent[1]?.messages[0]?.content)).toContain('Native tool calling is unavailable');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.[0]?.function.name).toBe('write_file');
  });
});
