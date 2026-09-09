import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import type { ChatMessage } from '../../src/llm/types';
import { prepareToolResultContext } from '../../src/agent/toolResultContext';
import {
  MIN_ROUND_HEADROOM_TOKENS,
  computeContextBudget,
  estimateTokens,
  minimumOutputReserve,
  reasoningReserve,
} from '../../src/util/contextBudget';

/**
 * The configuration that killed session 3c073ca7 on 2026-09-09: a 65k
 * single-slot window and a 4096-token reasoning budget.
 */
const model = {
  name: 'qwen38-flashnext',
  spawn: {
    num_ctx: 65000,
    n_parallel: 1,
    extra_llama_server_args: ['--reasoning-budget', '4096'],
  },
} as ModelConfig;

const toolResults = (count: number, chars: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    role: 'tool' as const,
    tool_call_id: `call_${i}`,
    content: 'x'.repeat(chars),
  }));

describe('minimumOutputReserve', () => {
  it('reserves the reasoning budget on top of an answer allowance', () => {
    expect(minimumOutputReserve(model)).toBe(4096 + MIN_ROUND_HEADROOM_TOKENS);
  });

  it('falls back to the answer allowance when the model has no reasoning budget', () => {
    const plain = { name: 'm', spawn: { num_ctx: 65000 } } as ModelConfig;
    expect(minimumOutputReserve(plain)).toBe(MIN_ROUND_HEADROOM_TOKENS);
  });
});

describe('prepareToolResultContext output reserve', () => {
  // The regression itself. The excerptor used to trim the prompt until exactly
  // MIN_ROUND_HEADROOM_TOKENS (4000) of output room remained. applyOutputCap
  // then took its 512-token margin, so the request went out with
  // max_tokens: 3488 against --reasoning-budget 4096 — the model could not
  // finish thinking, so it never produced content or a tool call, and
  // llama.cpp never injected --reasoning-budget-message either.
  it('never leaves less output room than the model needs to finish thinking', () => {
    const messages = toolResults(40, 6000);
    const prepared = prepareToolResultContext({
      messages,
      toolTokens: 18_000,
      model,
    });
    const budget = computeContextBudget({
      messages: prepared.messages,
      toolTokens: 18_000,
      model,
    });
    expect(budget.outputRoom).toBeGreaterThan(reasoningReserve(model));
    // And enough left over to actually answer once thinking is paid for.
    expect(budget.headroom).toBeGreaterThanOrEqual(MIN_ROUND_HEADROOM_TOKENS);
  });
});

describe('estimateTokens', () => {
  // Measured 2026-09-09 on the live llama-server tokenizer over the failing
  // session's 138,571 chars of tool results: 3.63 chars/token. The flat 3.1
  // rate over-counted them by ~17%, and the excerptor cut real content to
  // satisfy a prompt size that was never there.
  it('counts a tool result at the tool-result rate, not the prose rate', () => {
    const text = 'y'.repeat(34_000);
    const asTool = estimateTokens([{ role: 'tool', tool_call_id: 'c', content: text }]);
    const asUser = estimateTokens([{ role: 'user', content: text }]);
    expect(asTool).toBeLessThan(asUser);
    expect(asTool).toBe(Math.ceil(34_000 / 3.4));
  });
});
