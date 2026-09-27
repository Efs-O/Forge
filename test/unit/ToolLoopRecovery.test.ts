import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import { ToolLoopDetectedError } from '../../src/agent/ToolLoopGuard';

interface Handlers {
  onToken: (t: string) => void;
  onReasoning: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onToolCalls: (calls: ToolCall[]) => void;
}

const CALL: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'read_file', arguments: '{"path":"a"}' },
};

/** Identical `read_file` calls forever, until `stopAfterRound` answers instead. */
function scriptRepeatedCalls(stopAfterRound: number): void {
  let round = 0;
  streamModelChatCompletion.mockImplementation(
    async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
      round += 1;
      if (round >= stopAfterRound) {
        h.onToken('done');
        h.onDone('stop');
        return;
      }
      h.onToolCalls([CALL]);
      h.onDone('tool_calls');
    },
  );
}

function runOptions(messages: ChatMessage[], onRepeatedCall: () => void) {
  return {
    resolveBaseUrl: async () => 'http://localhost:0',
    model: { name: 'test-model' } as never,
    messages,
    getToolDefinitions: () => [{ type: 'function', function: { name: 'read_file' } }] as never,
    dispatchToolCalls: async (calls: ToolCall[], msgs: ChatMessage[]) => {
      for (const c of calls) {
        msgs.push({ role: 'tool', content: 'same', tool_call_id: c.id, name: 'read_file' });
      }
    },
    signal: new AbortController().signal,
    maxRounds: 25,
    nativeTools: true,
    onRepeatedCall,
  };
}

describe('ToolCallingLoop loop-guard recovery', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  it('absorbs a loop-guard stop with an automatic nudge instead of ending the turn', async () => {
    scriptRepeatedCalls(7);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const onRepeatedCall = vi.fn();
    const result = await runToolCallingLoop(runOptions(messages, onRepeatedCall) as never);

    expect(result.finalText).toBe('done');
    expect(onRepeatedCall).not.toHaveBeenCalled();
    const nudge = messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('automatic retry'),
    );
    expect(nudge).toBeDefined();
  });

  it('absorbs two consecutive loop-guard stops before ending the turn on the third', async () => {
    scriptRepeatedCalls(Number.POSITIVE_INFINITY);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const onRepeatedCall = vi.fn();
    await expect(
      runToolCallingLoop(runOptions(messages, onRepeatedCall) as never),
    ).rejects.toThrow(ToolLoopDetectedError);

    // Only the final, unrecovered stop is reported — the two absorbed ones are silent.
    expect(onRepeatedCall).toHaveBeenCalledTimes(1);
    const nudges = messages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('continuing this turn automatically'),
    );
    expect(nudges).toHaveLength(2);
    expect(nudges[0]?.content).toContain('1 more automatic retry left');
    expect(nudges[1]?.content).toContain('0 more automatic retries left');
  });
});
