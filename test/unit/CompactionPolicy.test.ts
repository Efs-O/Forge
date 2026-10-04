import { describe, expect, it } from 'vitest';
import {
  compactionBudget,
  fitSummaryPrompt,
} from '../../src/sidebar/compactionBudget';
import { buildSummaryPrompt, capSummary } from '../../src/sidebar/compactionPrompt';
import type { ChatMessage } from '../../src/llm/types';

describe('percentage compaction policy', () => {
  it('budgets the 170k trigger against P rather than the 200k maximum', () => {
    const budget = compactionBudget(170_000, 100_000, 200_000);
    expect(budget.policyTokens).toBe(170_000);
    expect(budget.summaryTargetTokens).toBe(6_800);
    expect(budget.summaryCeilingTokens).toBe(17_000);
    expect(budget.tailMaxChars).toBe(6_375);
    expect(budget.replacementMaxChars).toBe(42_500);
    expect(budget.sourceMaxChars).toBe(340_000);
    expect(budget.estimated).toBe(false);
  });

  it('uses an estimate and a manual-compact floor when no usage has been reported', () => {
    const budget = compactionBudget(0, 500, 200_000);
    expect(budget.estimated).toBe(true);
    expect(budget.policyTokens).toBe(20_000);
    expect(budget.summaryCeilingChars).toBe(12_000);
    expect(budget.sourceMaxChars).toBeGreaterThan(24_000);
  });

  it('reduces the source when the complete summarizer request would overfill its slot', () => {
    const budget = compactionBudget(170_000, 100_000, 150_000);
    const fit = fitSummaryPrompt(budget, 150_000, (sourceChars) =>
      'x'.repeat(sourceChars + 20_000),
    );
    expect(fit.sourceMaxChars).toBeLessThan(budget.sourceMaxChars);
    expect(fit.estimatedTokens + budget.summaryCeilingTokens + 6_000).toBeLessThanOrEqual(
      150_000,
    );
  });

  it('fits the dynamic output allowance, reasoning reserve, and margin in the model window', () => {
    const budget = compactionBudget(170_000, 100_000, 150_000, 8_192);
    const outputTokens = Math.floor(7_000 / 2.5);
    const fit = fitSummaryPrompt(
      budget,
      150_000,
      (sourceChars) => 'x'.repeat(sourceChars),
      8_192,
      outputTokens,
    );
    expect(fit.estimatedTokens + outputTokens + 8_192 + 6_000).toBeLessThanOrEqual(150_000);
  });

  it('keeps a finding in the middle while omitting routine tool dumps', () => {
    const budget = compactionBudget(170_000, 300_000, 200_000);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Audit these commits.' },
      ...Array.from(
        { length: 140 },
        (_, i): ChatMessage => ({ role: 'tool', content: `routine ${i}: ${'x'.repeat(5_000)}` }),
      ),
      {
        role: 'assistant',
        content: 'F2 verified: commit abc123 causes two Strata starts; the replay failed.',
      },
      ...Array.from(
        { length: 140 },
        (_, i): ChatMessage => ({ role: 'tool', content: `later ${i}: ${'y'.repeat(5_000)}` }),
      ),
      { role: 'assistant', content: 'Next: fix F2 and rerun its concurrency test.' },
    ];
    const prompt = buildSummaryPrompt(undefined, messages, '', '', undefined, budget);
    expect(prompt).toContain('commit abc123 causes two Strata starts');
    expect(prompt).toContain('Next: fix F2');
    expect(prompt).toContain('tool results omitted for space');
    expect(prompt).not.toContain('routine 70:');
  });

  it('keeps a complete long assistant finding instead of silently cutting its evidence', () => {
    const finding = `Commit list: ${'abcdef012345 '.repeat(600)}`;
    const prompt = buildSummaryPrompt(
      undefined,
      [{ role: 'assistant', content: finding }],
      '',
      '',
      undefined,
      compactionBudget(170_000, 100_000, 200_000),
    );
    expect(prompt).toContain(finding);
  });

  it('refuses when indispensable messages cannot fit the source budget', () => {
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: 'assistant',
      content: `finding ${i}: ${'a'.repeat(3_000)}`,
    }));
    expect(() =>
      buildSummaryPrompt(undefined, messages, '', '', undefined, {
        sourceMaxChars: 4_000,
        summaryTargetTokens: 1_000,
        summaryCeilingTokens: 1_250,
      }),
    ).toThrow(/cannot retain all user decisions and assistant findings/u);
  });

  it('refuses an oversized visible summary instead of cutting off findings or Next', () => {
    expect(() => capSummary('a'.repeat(30_000), 21_250)).toThrow(/exceeding/u);
  });
});
