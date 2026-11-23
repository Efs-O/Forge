import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';

interface Handlers {
  onToken: (t: string) => void;
  onDone: (finishReason: string | null) => void;
}

function def(
  name: string,
  parameters: Record<string, unknown> = { type: 'object', properties: {} },
): ToolDefinition {
  return { type: 'function', function: { name, description: '', parameters } };
}

/** A call to a tool the request never listed, written in the marker form. */
const MARKER_CALL =
  'Counting.\n<tool_call>\n<function=count_things>\n<parameter=n>\n3\n</parameter>\n</function>\n</tool_call>';

/** The fenced form, which only passes the name filter when the name is known. */
const FENCED_CALL =
  '```json\n{"tool": "remember", "arguments": {"key": "k", "value": "v"}}\n```\nDone.';

/** `remember`'s real parameters (src/tools/memoryTools.ts). */
const REMEMBER = def('remember', {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Memory key (used to recall later).' },
    value: { type: 'string', description: 'Value to store.' },
    description: { type: 'string', description: 'One line saying what this memory holds.' },
  },
  required: ['key', 'value'],
  additionalProperties: false,
});

const COUNT_THINGS = def('count_things', {
  type: 'object',
  properties: { n: { type: 'integer' } },
});

async function run(
  text: string,
  opts: {
    textDefs: ToolDefinition[];
    nativeTools: boolean;
    listed?: ToolDefinition[];
  },
): Promise<{ dispatched: ToolCall[][]; reported: Array<[string[], string[]]> }> {
  const dispatched: ToolCall[][] = [];
  const reported: Array<[string[], string[]]> = [];
  let round = 0;
  streamModelChatCompletion.mockImplementation(
    async (_url: string, _req: ChatCompletionRequest, _model: unknown, h: Handlers) => {
      h.onToken(round === 0 ? text : 'Done.');
      round += 1;
      h.onDone('stop');
    },
  );
  const messages = [{ role: 'user', content: 'go' }] as ChatMessage[];
  await runToolCallingLoop({
    resolveBaseUrl: async () => 'http://localhost:0',
    model: { name: 'test-model' } as never,
    messages,
    getToolDefinitions: () => opts.listed ?? [def('read_file')],
    getTextCallDefinitions: () => opts.textDefs,
    onTextToolCalls: (names, unlisted) => reported.push([[...names], [...unlisted]]),
    dispatchToolCalls: async (calls: ToolCall[]) => {
      dispatched.push(calls);
    },
    signal: new AbortController().signal,
    maxRounds: 2,
    nativeTools: opts.nativeTools,
  } as never);
  return { dispatched, reported };
}

describe('a text call to a tool the request did not list', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  it('types the integer parameter and reports the name as unlisted', async () => {
    const { dispatched, reported } = await run(MARKER_CALL, {
      textDefs: [COUNT_THINGS],
      nativeTools: true,
    });
    expect(dispatched).toHaveLength(1);
    const call = dispatched[0]?.[0];
    expect(call?.function.name).toBe('count_things');
    expect(call?.function.arguments).toBe('{"n":3}');
    expect(reported).toEqual([[['count_things'], ['count_things']]]);
  });

  it('leaves the parameter a string when no text definitions are supplied', async () => {
    const { dispatched } = await run(MARKER_CALL, { textDefs: [], nativeTools: true });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.[0]?.function.arguments).toBe('{"n":"3"}');
  });

  it('admits a fenced-JSON call only when the name is in the text definitions', async () => {
    const known = await run(FENCED_CALL, { textDefs: [REMEMBER], nativeTools: false });
    expect(known.dispatched).toHaveLength(1);
    expect(known.dispatched[0]?.[0]?.function.name).toBe('remember');
    expect(known.dispatched[0]?.[0]?.function.arguments).toContain('"key":"k"');

    const unknown = await run(FENCED_CALL, { textDefs: [], nativeTools: false });
    expect(unknown.dispatched).toEqual([]);
  });
});
