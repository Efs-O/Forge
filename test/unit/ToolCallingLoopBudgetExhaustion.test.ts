import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import type { ModelConfig } from '../../src/config/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import {
  OUTPUT_BUDGET_EXHAUSTED_NOTICE,
  REASONING_ONLY_STOP_NOTICE,
  REASONING_STOP_RETRY_NUDGE,
  RETRY_REASONING_TAIL_CHARS,
  reasoningStopRetryNudge,
} from '../../src/agent/truncationRecovery';

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

  // Session 79db75af: the model emitted EOS right after the injected
  // --reasoning-budget-message — finish_reason=stop, text_chars=0,
  // reasoning_chars=14950. The old `length`-only guard let it end silently.
  it('retries a stop inside the thinking block once, with thinking off', async () => {
    const requests: Array<{ chat_template_kwargs?: { enable_thinking?: boolean } }> = [];
    streamModelChatCompletion
      .mockImplementationOnce(async (_u: string, r: never, _m: unknown, h: Handlers) => {
        requests.push(r);
        h.onReasoning('weighing the options. Stop reasoning now. Otherwise end reasoning.');
        h.onDone('stop');
      })
      .mockImplementationOnce(async (_u: string, r: never, _m: unknown, h: Handlers) => {
        requests.push(r);
        h.onToken('Both wakes worked.');
        h.onDone('stop');
      });
    const messages: ChatMessage[] = [{ role: 'user', content: 'resume' }];
    const options = { ...baseOptions(messages), canUseThinkingKwargs: true };
    const result = await runToolCallingLoop(options as never);

    expect(result.finalText).toBe('Both wakes worked.');
    expect(result.stoppedWhileReasoning).toBeUndefined();
    expect(streamModelChatCompletion).toHaveBeenCalledTimes(2);
    expect(requests[1]?.chat_template_kwargs?.enable_thinking).toBe(false);
    // Reasoning never reaches the wire, so the nudge itself carries it.
    const nudge = messages.find((m) => m.internal === true);
    expect(nudge?.role).toBe('user');
    expect(nudge?.content).toContain(REASONING_STOP_RETRY_NUDGE);
    expect(nudge?.content).toContain('weighing the options.');
    expect(requests[1]).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ content: nudge?.content })]),
    });
  });

  it('quotes only the tail of a long stopped reasoning into the retry nudge', () => {
    const reasoning = `${'x'.repeat(RETRY_REASONING_TAIL_CHARS)}DECIDED: edit foo.ts`;
    const nudge = reasoningStopRetryNudge(reasoning);
    expect(nudge).toContain('DECIDED: edit foo.ts');
    expect(nudge.length).toBeLessThan(REASONING_STOP_RETRY_NUDGE.length + RETRY_REASONING_TAIL_CHARS + 100);
    expect(reasoningStopRetryNudge('  ')).toBe(REASONING_STOP_RETRY_NUDGE);
  });

  it('surfaces the stop when the retry also ends inside the thinking block', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => {
        h.onReasoning('still thinking');
        h.onDone('stop');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'resume' }];
    const result = await runToolCallingLoop(baseOptions(messages) as never);

    expect(result.finishReason).toBe('stop');
    expect(result.finalText).toBe('');
    expect(result.stoppedWhileReasoning).toBe(true);
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: REASONING_ONLY_STOP_NOTICE });
    // One retry, not a loop.
    expect(streamModelChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('does not flag a length stop as stopped-while-reasoning', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => {
        h.onReasoning('cut off mid');
        h.onDone('length');
      },
    );
    const result = await runToolCallingLoop(baseOptions([{ role: 'user', content: 'go' }]) as never);
    expect(result.stoppedWhileReasoning).toBe(false);
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
