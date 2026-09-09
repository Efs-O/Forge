import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import type { ModelConfig } from '../../src/config/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import { OUTPUT_BUDGET_EXHAUSTED_NOTICE } from '../../src/agent/truncationRecovery';

interface Handlers {
  onToken: (t: string) => void;
  onReasoning: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onToolCalls: (calls: ToolCall[]) => void;
}

const model = {
  name: 'qwen38-flashnext',
  spawn: {
    num_ctx: 65000,
    n_parallel: 1,
    extra_llama_server_args: ['--reasoning-budget', '4096'],
  },
} as ModelConfig;

function baseOptions(messages: ChatMessage[], outputRoom?: number) {
  return {
    resolveBaseUrl: async () => 'http://localhost:0',
    model,
    messages,
    getToolDefinitions: () => [{ type: 'function', function: { name: 'wait' } }] as never,
    dispatchToolCalls: async () => undefined,
    signal: new AbortController().signal,
    maxRounds: 5,
    nativeTools: true,
    ...(outputRoom === undefined ? {} : { getOutputRoom: () => outputRoom }),
  };
}

describe('a round that spends its whole budget thinking', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  // Session 3c073ca7: reasoning ran to the max_tokens ceiling, so there was no
  // content and no tool call. The loop treated "no tool calls" as a finished
  // answer and returned an empty finalText — the turn simply stopped, and
  // nothing in the transcript said why.
  it('records the cut-off instead of returning it as an answer', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => {
        h.onReasoning('planning the implementation, at length, and then bein');
        h.onDone('length');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const result = await runToolCallingLoop(baseOptions(messages) as never);

    expect(result.finishReason).toBe('length');
    expect(result.finalText).toBe('');
    const notice = messages.filter(
      (m) => m.role === 'assistant' && m.content === OUTPUT_BUDGET_EXHAUSTED_NOTICE,
    );
    expect(notice).toHaveLength(1);
    // One attempt only: it must not silently loop on an unwinnable round.
    expect(streamModelChatCompletion).toHaveBeenCalledTimes(1);
  });

  // The request that proved this cost 13.5 minutes to produce nothing: with
  // max_tokens below --reasoning-budget the model cannot finish thinking, so
  // the outcome is decided before the first token.
  it('refuses to send a round with less output room than the reasoning budget', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    await expect(
      runToolCallingLoop(baseOptions(messages, 4000) as never),
    ).rejects.toThrow(/context/i);
    expect(streamModelChatCompletion).not.toHaveBeenCalled();
  });

  it('still sends a round with room to spare', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => {
        h.onToken('done');
        h.onDone('stop');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const result = await runToolCallingLoop(baseOptions(messages, 9000) as never);
    expect(result.finalText).toBe('done');
    expect(streamModelChatCompletion).toHaveBeenCalledTimes(1);
  });
});
