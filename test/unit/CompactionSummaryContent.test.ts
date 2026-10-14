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

  it('keeps an attachment note and only its first 2,000 chars in summarizer input', () => {
    const fileText = `${'A'.repeat(2_000)}SYNTHETIC_SUMMARY_ATTACHMENT_TAIL_${'B'.repeat(5_000)}`;
    const message: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Review this:' },
        { type: 'text', text: `\`\`\`readme.md\n${fileText}\n\`\`\`` },
      ],
      attachments: [
        {
          name: 'readme.md',
          mediaType: 'text/markdown',
          bytes: 1_000_000,
          relativePath: 'c/readme.md',
        },
      ],
    };
    const prompt = buildSummaryPrompt(
      'test time',
      undefined,
      [message],
      '',
      '',
      undefined,
      { sourceMaxChars: 12_000 },
    );
    const retainedText = fileText.slice(0, 2_000);

    expect(prompt).toContain('Review this:');
    expect(prompt).toContain(
      '[attached file readme.md, 1000000 bytes — not kept in compacted context; ask the user to re-attach it if it is needed]',
    );
    expect(prompt).toContain(retainedText);
    expect(prompt).not.toContain(fileText.slice(2_000, 2_100));
  });

  it('condenses a long earlier summary without changing the summary allowance', () => {
    const previousSummary =
      'Completed edit: file A changed. Superseded choice: use old API. Resolved error: missing import. '.repeat(
        80,
      );
    const messages: ChatMessage[] = [{ role: 'user', content: 'Continue the task.' }];
    const allowance = compactionSummaryAllowance(8_000, 12_000, 1_000, 'resume note');
    const prompt = buildSummaryPrompt(
      'Monday, October 5, 2026 at 14:05',
      previousSummary,
      messages,
      '',
      '',
      undefined,
      { sourceMaxChars: 10_000, summaryMaxChars: 4_000 },
    );

    expect(prompt).toContain('Merge the earlier summary into this one and condense it on every compaction.');
    expect(prompt).toContain('Completed work should shrink to one line per item');
    expect(prompt).toContain('drop superseded decisions and resolved errors');
    expect(prompt).toContain('Keep open work and current file state detailed.');
    expect(prompt).toContain('Keep the summary target fixed across compactions');
    expect(compactionSummaryAllowance(8_000, 12_000, 1_000, 'resume note')).toBe(allowance);
  });
});
