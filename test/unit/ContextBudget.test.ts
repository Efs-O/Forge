import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import {
  CHARS_PER_TOKEN,
  computeContextBudget,
  estimateTokens,
  perSlotContext,
  reasoningReserve,
  reportedContextTokens,
  SYSTEM_AND_TEMPLATE_OVERHEAD,
} from '../../src/util/contextBudget';

describe('perSlotContext', () => {
  // --ctx-size is the TOTAL and --parallel divides it (LlamaServerArgs). Reading
  // num_ctx alone reported every multi-slot model at several times its window.
  it('divides the configured window by the slot count', () => {
    const model = { name: 'm', num_ctx: 131072, spawn: { n_parallel: 4 } } as ModelConfig;
    expect(perSlotContext(model)).toBe(32768);
  });

  it('gives a single-slot model the whole window', () => {
    const model = { name: 'm', num_ctx: 49152, spawn: { n_parallel: 1 } } as ModelConfig;
    expect(perSlotContext(model)).toBe(49152);
  });

  it('falls back to the server defaults when the model sets neither', () => {
    const model = { name: 'm' } as ModelConfig;
    expect(perSlotContext(model, { default_num_ctx: 65536, n_parallel: 2 } as never)).toBe(32768);
  });

  it('reports 0 for a model with no configured window', () => {
    expect(perSlotContext({ name: 'gpt', provider: 'openai' } as ModelConfig)).toBe(0);
  });
});

describe('reasoningReserve', () => {
  it('reads --reasoning-budget out of the spawn args', () => {
    const model = {
      name: 'm',
      spawn: {
        extra_llama_server_args: ['--reasoning-budget', '8192', '--spec-type', 'draft-mtp'],
      },
    } as ModelConfig;
    expect(reasoningReserve(model)).toBe(8192);
  });

  it('is zero when no budget is configured', () => {
    expect(reasoningReserve({ name: 'm' } as ModelConfig)).toBe(0);
  });

  it('ignores a malformed budget rather than poisoning the arithmetic', () => {
    const model = {
      name: 'm',
      spawn: { extra_llama_server_args: ['--reasoning-budget'] },
    } as ModelConfig;
    expect(reasoningReserve(model)).toBe(0);
  });
});

describe('estimateTokens', () => {
  // ChatMessage.reasoning is retained for the sidebar's thinking pane but is
  // never sent back to the model, so it costs no prompt tokens. Counting it
  // inflated the bar by the whole turn's thinking — ToolCallingLoop attaches
  // reasoning to EVERY tool-call round, so the error compounded per round.
  it('ignores reasoning, which is never sent to the model', () => {
    const withoutReasoning = [{ role: 'assistant' as const, content: 'hello' }];
    const withReasoning = [
      { role: 'assistant' as const, content: 'hello', reasoning: 'z'.repeat(20000) },
    ];
    expect(estimateTokens(withReasoning)).toBe(estimateTokens(withoutReasoning));
  });
});

describe('computeContextBudget', () => {
  const model = {
    name: 'm',
    num_ctx: 49152,
    spawn: {
      n_parallel: 1,
      extra_llama_server_args: ['--reasoning-budget', '8192'],
    },
  } as ModelConfig;

  it('reports the full generation room and the reserve-adjusted headroom separately', () => {
    const { used, max, outputRoom, headroom } = computeContextBudget({
      messages: [{ role: 'user', content: 'x'.repeat(4000) }],
      toolTokens: 3000,
      model,
    });
    expect(max).toBe(49152);
    expect(used).toBe(Math.ceil(4000 / CHARS_PER_TOKEN) + 3000 + SYSTEM_AND_TEMPLATE_OVERHEAD);
    // outputRoom is what max_tokens must be: the model spends thinking out of
    // it too, so subtracting the reserve here would double-count it.
    expect(outputRoom).toBe(49152 - used);
    // headroom is what is left for the answer once thinking has had its share.
    expect(headroom).toBe(49152 - used - 8192);
  });

  it('reports no headroom when the window is unknown', () => {
    const budget = computeContextBudget({
      messages: [{ role: 'user', content: 'hi' }],
      model: { name: 'gpt', provider: 'openai' } as ModelConfig,
    });
    expect(budget.max).toBe(0);
    expect(budget.outputRoom).toBe(0);
    expect(budget.headroom).toBe(0);
  });

  it('never goes negative once the prompt has overrun the window', () => {
    const budget = computeContextBudget({
      messages: [{ role: 'user', content: 'x'.repeat(400000) }],
      model,
    });
    expect(budget.headroom).toBe(0);
    expect(budget.outputRoom).toBe(0);
  });
});

describe('reportedContextTokens', () => {
  it('sums prompt and completion, because the completion becomes prompt next round', () => {
    expect(reportedContextTokens({ last_input_tokens: 12_000, last_output_tokens: 345 })).toBe(
      12_345,
    );
  });

  it('is 0 before any response, rather than falling back to an estimate', () => {
    expect(reportedContextTokens({})).toBe(0);
  });

  it('tolerates a half-populated record from an older session file', () => {
    expect(reportedContextTokens({ last_input_tokens: 900 })).toBe(900);
    expect(reportedContextTokens({ last_output_tokens: 40 })).toBe(40);
  });
});
