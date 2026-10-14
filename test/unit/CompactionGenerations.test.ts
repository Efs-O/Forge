import { describe, expect, it } from 'vitest';
import { compactionBudget } from '../../src/sidebar/compactionBudget';
import { compactionSummaryAllowance } from '../../src/sidebar/compactionSummaryRunner';

describe('stable compaction generations', () => {
  it('keeps the reserved summary share stable across usage and growing host facts', () => {
    const windowTokens = 128_000;
    const ratio = 2.5;
    const usageShares = [0.4, 0.85, 1, 0.4, 0.85, 1, 0.4, 0.85, 1, 0.4];
    const summaryAllowances: number[] = [];

    for (let generation = 0; generation < 10; generation++) {
      const usageTokens = Math.floor(windowTokens * usageShares[generation]!);
      const budget = compactionBudget(
        usageTokens,
        windowTokens * ratio,
        windowTokens,
        0,
        ratio,
        windowTokens,
      );
      const recordedActionCount = Math.min(48, (generation + 1) * 5);
      const memoryKeyCount = Math.min(40, (generation + 1) * 4);
      // Synthetic host facts grow to their lane-owned caps but remain within H;
      // host shedding is tested by the host-fit lane.
      const hostChars = Math.min(
        budget.hostMaxChars,
        recordedActionCount * 250 + memoryKeyCount * 100,
      );
      const summaryAllowance = compactionSummaryAllowance(
        budget.summaryCeilingChars,
        budget.replacementMaxChars,
        hostChars + budget.tailMaxChars,
        '',
      );
      const fakeSummary = 's'.repeat(Math.floor(summaryAllowance * 0.75));
      const replacementChars = hostChars + budget.tailMaxChars + fakeSummary.length;

      summaryAllowances.push(summaryAllowance);
      expect(fakeSummary.length).toBe(Math.floor(summaryAllowance * 0.75));
      expect(replacementChars).toBeLessThanOrEqual(budget.replacementMaxChars);
      expect(recordedActionCount).toBeLessThanOrEqual(48);
      expect(memoryKeyCount).toBeLessThanOrEqual(40);
    }

    expect(new Set(summaryAllowances).size).toBe(1);
  });
});
