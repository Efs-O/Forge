import { describe, expect, it } from 'vitest';
import { buildSummaryPrompt } from '../../src/sidebar/compactionPrompt';
import {
  compactionResumeNote,
  compactionSummaryAllowance,
} from '../../src/sidebar/compactionSummaryRunner';
import type { ChatMessage } from '../../src/llm/types';

describe('compaction summary content', () => {
  it('states compact rules for errors, hit limits, and expired time constraints', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Continue the task.' }];
    const currentLocalTime = 'Monday, October 5, 2026 at 14:05';
    const prompt = buildSummaryPrompt(currentLocalTime, undefined, messages);

    expect(prompt).toContain('list blockers that are still unresolved');
    expect(prompt).toContain('keep only the lesson, stated once as a rule');
    expect(prompt).toContain('merge any lesson the earlier summary already has');
    expect(prompt).toContain('with no history of fixed typos');
    expect(prompt).toContain('Put a hit limit under Constraints with its number and tool.');
    expect(prompt).toContain('Drop a time-bound constraint once that time has passed.');
    expect(prompt).toContain(currentLocalTime);
  });

  it('adds the plan refresh note only for a plan and budgets its characters', () => {
    const groupsNote = 'Newly available tool groups: memory.';
    const withPlan = compactionResumeNote(groupsNote, true);
    const withoutPlan = compactionResumeNote(groupsNote, false);
    const planLine =
      'If a plan is shown, check it against the State section and update it with `update_plan` before continuing.';

    expect(withPlan).toContain(planLine);
    expect(withoutPlan).not.toContain(planLine);
    expect(compactionSummaryAllowance(12_000, 14_000, 2_000, withPlan)).toBe(
      Math.min(12_000, 14_000 - 2_000) - withPlan.length,
    );
  });
});
