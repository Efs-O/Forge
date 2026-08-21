import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';

interface Handlers {
  onToken: (t: string) => void;
  onReasoning: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onToolCalls: (calls: ToolCall[]) => void;
  onUsage?: (usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }) => void;
}

const CALL: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'read_file', arguments: '{}' },
};

/** Round 1 reasons then calls a tool; round 2 reasons then answers. */
function scriptTwoRounds(): void {
  let round = 0;
  streamModelChatCompletion.mockImplementation(
    async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
      round += 1;
      if (round === 1) {
        h.onReasoning('round one thinking');
        h.onToolCalls([CALL]);
        h.onDone('tool_calls');
      } else {
        h.onReasoning('round two thinking');
        h.onToken('final answer');
        h.onDone('stop');
      }
    },
  );
}

function runOptions(messages: ChatMessage[]) {
  return {
    baseUrl: 'http://localhost:0',
    model: { name: 'test-model' } as never,
    messages,
    toolDefinitions: [{ type: 'function', function: { name: 'read_file' } }] as never,
    dispatchToolCalls: async (calls: ToolCall[], msgs: ChatMessage[]) => {
      for (const c of calls) {
        msgs.push({
          role: 'tool',
          content: 'file contents',
          tool_call_id: c.id,
          name: 'read_file',
        });
      }
    },
    signal: new AbortController().signal,
    maxRounds: 5,
    nativeTools: true,
  };
}

describe('ToolCallingLoop reasoning retention', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  // rawReasoning resets each round, so a round that ended in a tool call used to
  // discard its thinking entirely — only the final round's reasoning survived.
  it('attaches the round reasoning to the tool-call assistant turn', async () => {
    scriptTwoRounds();
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    await runToolCallingLoop(runOptions(messages) as never);

    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);

    const toolTurn = assistants[0]!;
    expect(toolTurn.content).toBeNull();
    expect(toolTurn.tool_calls).toHaveLength(1);
    expect(toolTurn.reasoning).toBe('round one thinking');

    const finalTurn = assistants[1]!;
    expect(finalTurn.content).toBe('final answer');
    expect(finalTurn.reasoning).toBe('round two thinking');
  });

  it('writes reasoning into the real transcript while it is still streaming', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    let streamedSnapshot: ChatMessage[] = [];
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        h.onReasoning('Now the docs — index.html control grids and README.');
        streamedSnapshot = messages.map((message) => ({ ...message }));
        h.onToken('Done.');
        h.onDone('stop');
      },
    );

    await runToolCallingLoop(runOptions(messages) as never);

    expect(streamedSnapshot).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        reasoning: 'Now the docs — index.html control grids and README.',
      },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'Done.',
        reasoning: 'Now the docs — index.html control grids and README.',
      },
    ]);
  });

  it('omits reasoning on a tool-call turn when the round produced none', async () => {
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        round += 1;
        if (round === 1) {
          h.onToolCalls([CALL]);
          h.onDone('tool_calls');
        } else {
          h.onToken('done');
          h.onDone('stop');
        }
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    await runToolCallingLoop(runOptions(messages) as never);

    const toolTurn = messages.filter((m) => m.role === 'assistant')[0]!;
    expect(toolTurn.tool_calls).toHaveLength(1);
    expect('reasoning' in toolTurn).toBe(false);
  });

  it('reports transcript mutations before and after a tool dispatch', async () => {
    scriptTwoRounds();
    const changed = vi.fn();

    await runToolCallingLoop({
      ...runOptions([{ role: 'user', content: 'go' }]),
      onMessagesChanged: changed,
    } as never);

    // Tool-call assistant turn, tool result, then final assistant reply.
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('requests and forwards the provider usage for each model call', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        h.onUsage?.({ prompt_tokens: 123, completion_tokens: 4, total_tokens: 127 });
        h.onToken('done');
        h.onDone('stop');
      },
    );
    const onUsage = vi.fn();

    await runToolCallingLoop({
      ...runOptions([{ role: 'user', content: 'go' }]),
      includeUsage: true,
      onUsage,
    } as never);

    const request = streamModelChatCompletion.mock.calls[0]![1] as {
      messages: ChatMessage[];
      tools: unknown[];
      stream_options?: { include_usage?: boolean };
    };
    expect(request.messages).toEqual([{ role: 'user', content: 'go' }]);
    expect(request.tools).toEqual(expect.any(Array));
    expect(request.stream_options).toEqual({ include_usage: true });
    expect(onUsage).toHaveBeenCalledWith({
      prompt_tokens: 123,
      completion_tokens: 4,
      total_tokens: 127,
    });
  });
});
