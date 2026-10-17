import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, ChatMessage, ToolCall } from '../../src/llm/types';
import type { ModelConfig } from '../../src/config/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import { ToolFailureTracker } from '../../src/tools/StripTools';
import { createOutputBudgetTracker, type PromptAnchor } from '../../src/util/contextBudget';
import {
  CONTEXT_INPUT_EXHAUSTED_MESSAGE,
  OUTPUT_BUDGET_EXHAUSTED_NOTICE,
  earlyServerLengthStopNotice,
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
  onUsage?: (usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }) => void;
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

  it('retries a server length stop well below max_tokens with thinking off', async () => {
    const requests: Array<{
      max_tokens?: number;
      chat_template_kwargs?: { enable_thinking?: boolean };
    }> = [];
    streamModelChatCompletion
      .mockImplementationOnce(
        async (_u: string, request: (typeof requests)[number], _m: unknown, h: Handlers) => {
          requests.push(request);
          h.onReasoning('The server stopped while I was thinking.');
          h.onUsage?.({ prompt_tokens: 10, completion_tokens: 34_195, total_tokens: 34_205 });
          h.onDone('length');
        },
      )
      .mockImplementationOnce(
        async (_u: string, request: (typeof requests)[number], _m: unknown, h: Handlers) => {
          requests.push(request);
          h.onToken('Completed the next concrete action.');
          h.onDone('stop');
        },
      );
    const messages: ChatMessage[] = [{ role: 'user', content: 'continue' }];
    const tracker = new ToolFailureTracker();

    const result = await runToolCallingLoop({
      ...baseOptions(messages, 140_859),
      maxOutputTokens: 140_347,
      canUseThinkingKwargs: true,
    } as never);

    expect(result.finalText).toBe('Completed the next concrete action.');
    expect(requests[0]?.max_tokens).toBe(140_347);
    expect(requests[1]?.chat_template_kwargs?.enable_thinking).toBe(false);
    expect(streamModelChatCompletion).toHaveBeenCalledTimes(2);
    expect(tracker.shouldStrip()).toBe(false);
  });

  it('keeps a length stop at the output cap on the existing exhausted-budget path', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, request: { max_tokens?: number }, _m: unknown, h: Handlers) => {
        expect(request.max_tokens).toBe(140_347);
        h.onReasoning('The output cap was reached.');
        h.onUsage?.({ prompt_tokens: 10, completion_tokens: 139_000, total_tokens: 139_010 });
        h.onDone('length');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'continue' }];

    await runToolCallingLoop({
      ...baseOptions(messages, 140_859),
      maxOutputTokens: 140_347,
    } as never);

    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: OUTPUT_BUDGET_EXHAUSTED_NOTICE,
      createdAt: expect.any(Number),
    });
    expect(streamModelChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('reports a second early length stop after the one reasoning retry', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _request: unknown, _m: unknown, h: Handlers) => {
        h.onReasoning('still reasoning');
        h.onUsage?.({ prompt_tokens: 10, completion_tokens: 34_195, total_tokens: 34_205 });
        h.onDone('length');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'continue' }];

    await runToolCallingLoop({
      ...baseOptions(messages, 140_859),
      maxOutputTokens: 140_347,
    } as never);

    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: earlyServerLengthStopNotice(34_195, 140_347),
      createdAt: expect.any(Number),
    });
    expect(streamModelChatCompletion).toHaveBeenCalledTimes(2);
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
    expect(nudge.length).toBeLessThan(
      REASONING_STOP_RETRY_NUDGE.length + RETRY_REASONING_TAIL_CHARS + 100,
    );
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
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: REASONING_ONLY_STOP_NOTICE,
      createdAt: expect.any(Number),
    });
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
    const result = await runToolCallingLoop(
      baseOptions([{ role: 'user', content: 'go' }]) as never,
    );
    expect(result.stoppedWhileReasoning).toBe(false);
  });

  // The request that proved this cost 13.5 minutes to produce nothing: with
  // max_tokens below --reasoning-budget the model cannot finish thinking, so
  // the outcome is decided before the first token.
  it('refuses to send a round with less output room than the reasoning budget', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    await expect(runToolCallingLoop(baseOptions(messages, 4000) as never)).rejects.toThrow(
      /context/i,
    );
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

describe('a server context 400 that states its own counts', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  // Strata, 2026-10-01: the estimate read the prompt ~7% short, so max_tokens
  // went out at 32768 with only ~32.7K left and the turn died on a raw 400.
  const strataRefusal = new Error(
    'HTTP 400: {"error": {"type": "invalid_request_error", "message": "prompt (121867 tokens) + max tokens (32768) exceeds the context (154624); requests are never truncated"}}',
  );

  it('resends the round capped to the room the server reported', async () => {
    const sent: Array<{ max_tokens?: number }> = [];
    streamModelChatCompletion.mockImplementation(
      async (_u: string, r: { max_tokens?: number }, _m: unknown, h: Handlers) => {
        sent.push(r);
        if (sent.length === 1) throw strataRefusal;
        h.onToken('done');
        h.onDone('stop');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const result = await runToolCallingLoop({
      ...baseOptions(messages, 40000),
      maxOutputTokens: 32768,
    } as never);

    expect(result.finalText).toBe('done');
    expect(sent.map((r) => r.max_tokens)).toEqual([32768, 154624 - 121867 - 512]);
  });

  it('fails as context exhaustion, not a raw 400, when the capped resend is refused too', async () => {
    streamModelChatCompletion.mockRejectedValue(strataRefusal);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    await expect(
      runToolCallingLoop({ ...baseOptions(messages, 40000), maxOutputTokens: 32768 } as never),
    ).rejects.toThrow(CONTEXT_INPUT_EXHAUSTED_MESSAGE);
    expect(streamModelChatCompletion).toHaveBeenCalledTimes(2);
  });
});

describe('anchored output budgets across actual requests', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  it('carries usage through a tool round and subtracts the proportional margin once', async () => {
    const requests: ChatCompletionRequest[] = [];
    const call: ToolCall = {
      id: 'read-1',
      type: 'function',
      function: { name: 'wait', arguments: '{}' },
    };
    streamModelChatCompletion.mockImplementation(
      async (_u: string, request: ChatCompletionRequest, _m: unknown, h: Handlers) => {
        requests.push(request);
        if (requests.length === 1) {
          h.onReasoning('reasoning is already covered by completion tokens');
          h.onUsage?.({ prompt_tokens: 150_000, completion_tokens: 4_000, total_tokens: 154_000 });
          h.onToken('I will inspect the code.');
          h.onToolCalls([call]);
          h.onDone('tool_calls');
        } else {
          h.onToken('done');
          h.onDone('stop');
        }
      },
    );
    const largeModel = { ...model, num_ctx: 200_000, spawn: { num_ctx: 200_000 } } as ModelConfig;
    const state: { promptEstimateScale?: number; promptAnchor?: PromptAnchor } = {};
    const tracker = createOutputBudgetTracker(state, largeModel);
    const result = await runToolCallingLoop({
      ...baseOptions([{ role: 'user', content: 'x'.repeat(465_000) }]),
      model: largeModel,
      maxOutputTokens: 200_000,
      ...tracker,
      dispatchToolCalls: async (_calls, messages) => {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'x'.repeat(34_000) });
      },
    });
    expect(result.finalText).toBe('done');
    expect(requests).toHaveLength(2);
    expect(state.promptAnchor?.messageCount).toBe(1);
    // The prior assistant is paid for by the 4K completion; the 10K result
    // and two new message delimiters are estimated and get equal extra slack.
    const estimatedTail = 10_000 + 16 * 2;
    expect(requests[1]?.max_tokens).toBe(200_000 - 154_000 - estimatedTail * 2 - 512);
  });

  it('measures the normalized fallback request and its actual offered schemas', async () => {
    let measuredMessages: ChatMessage[] | undefined;
    let measuredTools: unknown[] | undefined;
    streamModelChatCompletion.mockImplementation(
      async (_u: string, request: ChatCompletionRequest, _m: unknown, h: Handlers) => {
        expect(measuredMessages).toEqual(request.messages);
        expect(measuredTools).toEqual(request.tools ?? []);
        expect(request.max_tokens).toBe(20_000 - 512 - 2_000);
        h.onToken('done');
        h.onDone('stop');
      },
    );
    await runToolCallingLoop({
      ...baseOptions([{ role: 'user', content: 'go' }]),
      nativeTools: false,
      maxOutputTokens: 65_000,
      getOutputRoom: (messages, tools) => {
        measuredMessages = messages;
        measuredTools = tools;
        return { outputRoom: 20_000, extraMarginTokens: 2_000 };
      },
    });
    expect(measuredTools).toEqual([]);
    expect(measuredMessages?.some((m) => m.role === 'system')).toBe(true);
  });

  it('checks the extra margin before starting an unwinnable reasoning round', async () => {
    await expect(
      runToolCallingLoop({
        ...baseOptions([{ role: 'user', content: 'go' }]),
        getOutputRoom: () => ({ outputRoom: 9_000, extraMarginTokens: 5_000 }),
      }),
    ).rejects.toThrow(/context/i);
    expect(streamModelChatCompletion).not.toHaveBeenCalled();
  });

  it.each([
    { outputRoom: 100, extraMarginTokens: 0 },
    { outputRoom: 4000, extraMarginTokens: 10_000 },
  ])('refuses when the margin leaves no useful output: %j', async (budget) => {
    await expect(
      runToolCallingLoop({
        ...baseOptions([{ role: 'user', content: 'go' }]),
        model: { ...model, spawn: { num_ctx: 65_000 } } as ModelConfig,
        getOutputRoom: () => budget,
      }),
    ).rejects.toThrow(CONTEXT_INPUT_EXHAUSTED_MESSAGE);
    expect(streamModelChatCompletion).not.toHaveBeenCalled();
  });

  it('remeasures and caps the changed prompt after a native tool JSON failure', async () => {
    const sent: ChatCompletionRequest[] = [];
    const measured: ChatMessage[][] = [];
    streamModelChatCompletion.mockImplementation(
      async (_u: string, request: ChatCompletionRequest, _m: unknown, h: Handlers) => {
        sent.push(request);
        if (sent.length === 1)
          throw new Error('Failed to parse tool call arguments as JSON: invalid token');
        h.onToken('done');
        h.onDone('stop');
      },
    );
    await runToolCallingLoop({
      ...baseOptions([{ role: 'user', content: 'go' }]),
      maxOutputTokens: 65_000,
      getOutputRoom: (messages, tools) => {
        measured.push(messages);
        return {
          outputRoom: tools.length ? 20_000 : 15_000,
          extraMarginTokens: tools.length ? 1000 : 0,
        };
      },
    });
    expect(sent.map((request) => request.max_tokens)).toEqual([18_488, 14_488]);
    expect(measured).toEqual(sent.map((request) => request.messages));
    expect(sent[1]?.tools).toBeUndefined();
    expect(sent[1]?.messages).not.toEqual(sent[0]?.messages);
  });
});
