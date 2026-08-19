import { describe, expect, it } from 'vitest';
import { applyCompactionWindow } from '../../src/sidebar/compactionWindow';
import {
  computeContextBudget,
  estimateTokens,
  SYSTEM_AND_TEMPLATE_OVERHEAD,
} from '../../src/util/contextBudget';
import type { ModelConfig } from '../../src/config/types';

describe('compacted context budget', () => {
  it('counts the summary and tail, rather than retained scrollback', () => {
    const messages = [
      { role: 'user' as const, content: 'x'.repeat(4000) },
      { role: 'assistant' as const, content: 'y'.repeat(4000) },
      { role: 'user' as const, content: 'continue' },
    ];
    const compacted = applyCompactionWindow(messages, { summary: 'finished the first task', fromIndex: 2 });
    const model = { name: 'm', num_ctx: 8192 } as ModelConfig;

    const retained = computeContextBudget({ messages, model });
    const sent = computeContextBudget({ messages: compacted, model });

    expect(sent.used).toBeLessThan(retained.used);
    // Derived, not hardcoded: the point of the assertion is that `used` is
    // exactly the compacted window plus the fixed overhead, so recalibrating
    // CHARS_PER_TOKEN or the overhead must not require editing this test.
    expect(sent.used).toBe(estimateTokens(compacted) + SYSTEM_AND_TEMPLATE_OVERHEAD);
  });
});
