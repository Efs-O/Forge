import { describe, expect, it } from 'vitest';
import { buildSummaryPrompt } from '../../src/sidebar/compactionPrompt';
import { CompactionFailure, compactionFailureCategory } from '../../src/sidebar/compactionFailure';
import {
  compactionBudget,
  fitSummaryPrompt,
  SummaryPromptFitError,
} from '../../src/sidebar/compactionBudget';
import { summarySource } from '../../src/sidebar/compactionSummarySource';
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
    expect(compactionSummaryAllowance(12_000, withPlan)).toBe(12_000 - withPlan.length);
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
    const prompt = buildSummaryPrompt('test time', undefined, [message], '', '', undefined, {
      sourceMaxChars: 12_000,
    });
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

    const prompt = buildSummaryPrompt('test time', undefined, messages, '', '', undefined, {
      sourceMaxChars: 12_000,
    });
    const source = prompt.slice(prompt.indexOf('Conversation:\n') + 'Conversation:\n'.length);

    expect(source.length).toBeLessThanOrEqual(12_000);
    expect(source).toContain('[for space: reasoning notes dropped from');
    expect(source).toContain('[for space: tool-call details reduced to names in');
    expect(source).toContain('[for space: 394 earlier assistant entries dropped]');
    expect(source).toContain(
      '[for space: earlier user entries cut to their first 1,000 chars (2)]',
    );
    expect(source).toContain('[for space: newest six entries reduced (6 affected)');
    expect(source).toContain('typed request');
  });

  it('names the final source floor when the available budget is below it', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'typed request' },
      ...Array.from({ length: 8 }, () => ({
        role: 'assistant' as const,
        content: 'A'.repeat(2_000),
      })),
    ];

    try {
      buildSummaryPrompt('test time', undefined, messages, '', '', undefined, {
        sourceMaxChars: 500,
      });
      throw new Error('expected floor refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionFailure);
      expect(error).toMatchObject({ category: 'budget-refusal' });
      expect(error).toHaveProperty('message', expect.stringContaining('floor:'));
    }
  });

  it('carries an earlier summary forward whole and keeps the summary target fixed', () => {
    const previousSummary =
      'Goal: finish the task.\nState: file A is updated.\nNext: run the focused check. ' +
      'Constraints: preserve the API. Errors: none. Reference: source is src/a.ts.';
    const messages: ChatMessage[] = [{ role: 'user', content: 'Continue the task.' }];
    const allowance = compactionSummaryAllowance(8_000, 'resume note');
    const prompt = buildSummaryPrompt(
      'Monday, October 5, 2026 at 14:05',
      previousSummary,
      messages,
      '',
      '',
      undefined,
      { sourceMaxChars: 10_000, summaryMaxChars: 4_000 },
    );

    expect(prompt).toContain(`EARLIER SUMMARY:\n${previousSummary}`);
    expect(prompt).toContain(
      'Carry forward everything from the earlier summary that is still true.',
    );
    expect(prompt).toContain(
      'Condense finished work to one line each and drop superseded decisions.',
    );
    expect(prompt).toContain('The size target is the same every compaction.');
    expect(prompt).toContain('Aim for about 3000 characters. Hard limit: 4000 characters;');
    expect(compactionSummaryAllowance(8_000, 'resume note')).toBe(allowance);
  });

  it('uses the reserved summary share, including the resume note, for the prior summary', () => {
    const previousSummary = `State: ${'still relevant. '.repeat(250)}`;
    const prompt = buildSummaryPrompt(
      'Monday, October 5, 2026 at 14:05',
      previousSummary,
      [{ role: 'user', content: 'Continue the task.' }],
      '',
      '',
      undefined,
      { sourceMaxChars: 10_000, summaryMaxChars: 4_000, previousSummaryMaxChars: 5_000 },
    );

    expect(prompt).toContain(`EARLIER SUMMARY:\n${previousSummary}`);
  });

  it('shortens a legacy oversized summary while retaining its head and Next section', () => {
    const previousSummary = [
      'Goal: preserve the active task.',
      `State: ${'finished work. '.repeat(80)}`,
      `Next: ${'continue the exact pending action. '.repeat(40)}`,
      `Files: ${'src/a.ts '.repeat(80)}`,
    ].join('\n');
    const prompt = buildSummaryPrompt(
      'Monday, October 5, 2026 at 14:05',
      previousSummary,
      [{ role: 'user', content: 'Continue the task.' }],
      '',
      '',
      undefined,
      { sourceMaxChars: 10_000, summaryMaxChars: 800 },
    );

    expect(prompt).toContain('Goal: preserve the active task.');
    expect(prompt).toContain('Next:');
    expect(prompt).toContain('continue the exact pending action.');
    expect(prompt).not.toContain('Files: src/a.ts');
  });
});

describe('summary source floor mode', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'typed request' },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: 'assistant' as const,
      content: `assistant ${index} ${'A'.repeat(1_000)}`,
      reasoning: `reasoning ${'R'.repeat(200)}`,
    })),
  ];

  it('returns a source that fits unchanged in normal mode', () => {
    const source = summarySource(messages, 100_000);
    expect(source).not.toContain('[for space:');
    expect(source).toContain('A'.repeat(1_000));
  });

  it('sheds the older transcript up front in floor mode even when it fits', () => {
    const source = summarySource(messages, 100_000, true);
    expect(source).toContain('[for space: reasoning notes dropped from');
    expect(source).toContain('typed request');
    expect(source.length).toBeLessThan(summarySource(messages, 100_000).length);
  });
});

describe('summary prompt fit refusal', () => {
  it('is a budget refusal, so the floor-mode retry and the attempt row see it as one', () => {
    const budget = compactionBudget(0, 200_000, 32_000, 0, undefined, 32_000);
    expect(() => fitSummaryPrompt(budget, 32_000, () => 'p'.repeat(500_000))).toThrow(
      SummaryPromptFitError,
    );
    try {
      fitSummaryPrompt(budget, 32_000, () => 'p'.repeat(500_000));
    } catch (error) {
      expect(compactionFailureCategory(error)).toBe('budget-refusal');
    }
  });
});
