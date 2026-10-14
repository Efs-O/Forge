import { describe, expect, it } from 'vitest';
import { buildSummaryPrompt } from '../../src/sidebar/compactionPrompt';
import { CompactionFailure } from '../../src/sidebar/compactionFailure';
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

  it('sheds a prose-heavy source to fit 12,000 chars without refusing', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: `typed request ${'U'.repeat(50_000)}` },
      ...Array.from({ length: 1 }, (_, index) => ({
        role: 'user' as const,
        content: `user entry ${index} ${'V'.repeat(20_000)}`,
      })),
      ...Array.from({ length: 400 }, (_, index) => ({
        role: 'assistant' as const,
        content: `assistant ${index} ${'A'.repeat(20_000)}`,
        reasoning: `reasoning ${'R'.repeat(2_000)}`,
        tool_calls: [
          {
            id: `call-${index}`,
            type: 'function' as const,
            function: { name: 'read_file', arguments: `{"path":"${'P'.repeat(1_000)}"}` },
          },
        ],
      })),
    ];

    const prompt = buildSummaryPrompt(
      'test time',
      undefined,
      messages,
      '',
      '',
      undefined,
      { sourceMaxChars: 12_000 },
    );
    const source = prompt.slice(prompt.indexOf('Conversation:\n') + 'Conversation:\n'.length);

    expect(source.length).toBeLessThanOrEqual(12_000);
    expect(source).toContain('[for space: reasoning notes dropped from');
    expect(source).toContain('[for space: tool-call details reduced to names in');
    expect(source).toContain('[for space: 394 earlier assistant entries dropped]');
    expect(source).toContain('[for space: earlier user entries cut to their first 1,000 chars (2)]');
    expect(source).toContain('[for space: newest six entries reduced (6 affected)');
    expect(source).toContain('typed request');
  });

  it('names the final source floor when the available budget is below it', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'typed request' },
      ...Array.from({ length: 8 }, () => ({ role: 'assistant' as const, content: 'A'.repeat(2_000) })),
    ];

    try {
      buildSummaryPrompt('test time', undefined, messages, '', '', undefined, { sourceMaxChars: 500 });
      throw new Error('expected floor refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionFailure);
      expect(error).toMatchObject({ category: 'budget-refusal' });
      expect(error).toHaveProperty('message', expect.stringContaining('floor:'));
    }
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
