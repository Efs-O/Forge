import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';

interface Handlers {
  onToken: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onToolCalls: (calls: ToolCall[]) => void;
}

/** A model that never stops calling tools — what the cap exists to bound. */
function scriptEndlessToolCalls(): void {
  let round = 0;
  streamModelChatCompletion.mockImplementation(
    async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
      round += 1;
      h.onToken(`edit ${round}`);
      h.onToolCalls([
        {
          id: `call_${round}`,
          type: 'function',
          // Distinct arguments each round: an identical repeat would trip
          // ToolLoopGuard instead, which is a different stop with its own test.
          function: { name: 'edit_file', arguments: `{"n":${round}}` },
        },
      ]);
      h.onDone('tool_calls');
    },
  );
}

function runOptions(messages: ChatMessage[], maxRounds: number) {
  return {
    baseUrl: 'http://localhost:0',
    model: { name: 'test-model' } as never,
    messages,
    getToolDefinitions: () => [{ type: 'function', function: { name: 'edit_file' } }] as never,
    dispatchToolCalls: async (calls: ToolCall[], msgs: ChatMessage[]) => {
      for (const c of calls) {
        msgs.push({ role: 'tool', content: `edited ${c.id}`, tool_call_id: c.id, name: 'edit_file' });
      }
    },
    signal: new AbortController().signal,
    maxRounds,
    nativeTools: true,
  };
}

describe('runToolCallingLoop at the round cap', () => {
  it('reports the cap instead of throwing it away', async () => {
    scriptEndlessToolCalls();
    const messages: ChatMessage[] = [{ role: 'user', content: 'refactor everything' }];

    // Throwing here used to discard finalText along with every trace of the
    // rounds that had already landed real edits.
    const result = await runToolCallingLoop(runOptions(messages, 3) as never);

    expect(result.hitRoundCap).toBe(true);
    expect(result.finishReason).toBe('max_rounds');
    expect(result.rounds).toBe(3);
  });

  it('leaves the stop in the transcript for the next request to see', async () => {
    scriptEndlessToolCalls();
    const messages: ChatMessage[] = [{ role: 'user', content: 'refactor everything' }];

    await runToolCallingLoop(runOptions(messages, 2) as never);

    const last = messages[messages.length - 1];
    expect(last?.role).toBe('assistant');
    expect(String(last?.content)).toContain('exceeded maximum tool rounds');
    // The work the capped turn did must still be there — that was the point.
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('does not flag a turn that finished on its own', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        h.onToken('done');
        h.onDone('stop');
      },
    );
    const result = await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'hi' }], 5) as never,
    );
    expect(result.hitRoundCap).toBe(false);
    expect(result.finishReason).toBe('stop');
  });
});
