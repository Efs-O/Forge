import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import { compactionBudget, planOutput } from '../../src/sidebar/compactionBudget';
import { fitSummaryToChars, missingSummarySections } from '../../src/sidebar/compactionPrompt';
import {
  compactionSummaryAllowance,
  summarizeCompaction,
} from '../../src/sidebar/compactionSummaryRunner';
import { PromptIncompleteError } from '../../src/sidebar/PromptRun';
import type { PromptRunOptions } from '../../src/sidebar/PromptRun';

const note = `Goal: finish the audit.
State: the earlier finding was corrected with evidence.
Next: continue the approved task.
Files: src/a.ts.
Constraints: the prior pause applied to the audit only.
Errors: none unresolved.
Reference: function signature is copied exactly. ${'Evidence. '.repeat(30)}`;

function input(
  messages: ChatMessage[],
  runPrompt: (text: string, id: string, options: PromptRunOptions) => Promise<string> = async () =>
    note,
) {
  return {
    messages,
    currentLocalTime: 'test local time',
    recordedFacts: 'Command completed successfully.',
    userContext: 'Audit the code.\nLater correction: implement the approved fix.',
    modelName: 'strata',
    modelMaxTokens: 200_000,
    outputLimitTokens: 32_768,
    reasoningTokens: 0,
    budget: compactionBudget(170_000, 400_000, 200_000, 0, undefined, 200_000),
    maximumSummaryChars: 25_000,
    conversationId: 'c1',
    runPrompt,
  };
}

const messages: ChatMessage[] = [
  { role: 'user', content: 'Audit the code.' },
  { role: 'assistant', content: 'Found a race in src/a.ts.' },
  { role: 'tool', content: `start of output\n${'x'.repeat(100_000)}\nfinal status: failed` },
  { role: 'user', content: 'Implement the approved fix.' },
];

describe('one-shot compaction', () => {
  it('uses one low-reasoning request with host facts and bounded tool output', async () => {
    const runPrompt = vi.fn(async (_text: string, _id: string, _options: PromptRunOptions) => note);
    const result = await summarizeCompaction(input(messages, runPrompt));
    expect(result).toMatchObject({ method: 'one-shot', calls: 1, summary: note.trim() });
    expect(runPrompt).toHaveBeenCalledTimes(1);
    const [prompt, , options] = runPrompt.mock.calls[0]!;
    expect(prompt).toContain('Later correction: implement the approved fix.');
    expect(prompt).toContain('Current local time: test local time.');
    expect(prompt).toContain('final status: failed');
    expect(prompt).toContain('For each earlier restriction, name the task it governed');
    expect(options).toMatchObject({ reasoningEffort: 'low', requireComplete: true });
  });

  it('asks for thinking off when the model has no reasoning reserve', async () => {
    const runPrompt = vi.fn(async (_text: string, _id: string, _options: PromptRunOptions) => note);
    await summarizeCompaction(input(messages, runPrompt));
    expect(runPrompt.mock.calls[0]![2]).toMatchObject({ disableThinking: true });
  });

  it('keeps thinking when a reserve is configured, since the cap already makes room for it', async () => {
    const runPrompt = vi.fn(async (_text: string, _id: string, _options: PromptRunOptions) => note);
    await summarizeCompaction({ ...input(messages, runPrompt), reasoningTokens: 3_072 });
    expect(runPrompt.mock.calls[0]![2].disableThinking).toBeUndefined();
  });

  it('names the same character ceiling in the prompt that the runner enforces', async () => {
    const runPrompt = vi.fn(async (_text: string, _id: string, _options: PromptRunOptions) => note);
    const request = input(messages, runPrompt);
    await summarizeCompaction(request);
    const prompt = runPrompt.mock.calls[0]![0];
    const ceiling = /Hard limit: (\d+) characters/u.exec(prompt)?.[1];
    expect(Number(ceiling)).toBe(request.maximumSummaryChars);
    expect(prompt).toContain(
      `Aim for about ${Math.floor(request.maximumSummaryChars * 0.75)} characters`,
    );
    expect(prompt).not.toMatch(/visible tokens/u);
  });

  it('cuts a summary over the ceiling the prompt named down to it', async () => {
    const request = input(messages, async () => note);
    const over = `${note}${'x'.repeat(Math.max(0, request.maximumSummaryChars - note.length + 1))}`;
    const result = await summarizeCompaction({ ...request, runPrompt: async () => over });
    expect(result.summary.length).toBeLessThanOrEqual(request.maximumSummaryChars);
    expect(result.cutFromChars).toBe(over.length);
    expect(result.summary).toContain('Next: continue the approved task.');
    expect(result.summary).toContain('[shortened to fit]');
  });

  it('keeps a length stop as a failure without a second request', async () => {
    const runPrompt = vi.fn(async (_text: string, _id: string, _options: PromptRunOptions) => {
      throw new PromptIncompleteError('length');
    });
    await expect(summarizeCompaction(input(messages, runPrompt))).rejects.toThrow(
      /finish_reason=length/u,
    );
    expect(runPrompt).toHaveBeenCalledTimes(1);
  });

  it('rejects an incomplete note without retrying', async () => {
    const runPrompt = vi.fn(async (_text: string, _id: string, _options: PromptRunOptions) =>
      'Goal: audit.\nState: incomplete.'.repeat(20),
    );
    await expect(summarizeCompaction(input(messages, runPrompt))).rejects.toThrow(
      /missing required sections/u,
    );
    expect(runPrompt).toHaveBeenCalledTimes(1);
  });

  it('requires the Reference heading on a complete summary', async () => {
    const withoutReference = note.replace('Reference: function signature is copied exactly. ', '');
    await expect(
      summarizeCompaction(input(messages, async () => withoutReference)),
    ).rejects.toThrow(/Reference/u);
  });

  it('budgets fixed shares from the model window with a 75% summary target', () => {
    const twoHundred = compactionBudget(170_000, 400_000, 200_000, 0, undefined, 200_000);
    expect(twoHundred.summaryCeilingChars).toBe(33_000);
    expect(twoHundred.summaryTargetTokens).toBe(9_900);
    expect(twoHundred.replacementMaxChars).toBe(60_000);
    expect(twoHundred.hostMaxChars).toBe(21_000);
    expect(twoHundred.tailMaxChars).toBe(6_000);
    const fourHundred = compactionBudget(340_000, 850_000, 400_000, 0, undefined, 400_000);
    expect(fourHundred.summaryCeilingChars).toBe(66_000);
    expect(fourHundred.summaryTargetTokens).toBe(19_800);
    expect(fourHundred.replacementMaxChars).toBe(120_000);
    expect(planOutput(10_000, 0, 32_768)).toEqual({ outputTokens: 10_000, requestCap: 10_000 });
  });

  it('keeps the host floor inside the replacement window at the smallest policy window', () => {
    const budget = compactionBudget(8_000, 50_000, 20_000, 0, 2.5, 20_000);

    expect(budget.hostMaxChars).toBeGreaterThanOrEqual(6_000);
    expect(
      budget.hostMaxChars + budget.summaryCeilingChars + budget.tailMaxChars,
    ).toBeLessThanOrEqual(budget.replacementMaxChars);
  });
});

describe('fitSummaryToChars', () => {
  const sections = [
    `Goal: ${'g'.repeat(300)}`,
    `State: ${'s'.repeat(5_000)}`,
    `Next: ${'n'.repeat(300)}`,
    `Files: ${'f'.repeat(200)}`,
    'Constraints: none recorded',
    'Errors: none recorded',
    `Reference: ${'r'.repeat(8_000)}`,
  ].join('\n');

  it('returns a summary within the limit unchanged', () => {
    expect(fitSummaryToChars(sections, sections.length)).toBe(sections);
  });

  it('cuts the longest bodies first, keeps every heading and Goal and Next whole', () => {
    const fitted = fitSummaryToChars(sections, 4_000)!;
    expect(fitted.length).toBeLessThanOrEqual(4_000);
    for (const heading of [
      'Goal:',
      'State:',
      'Next:',
      'Files:',
      'Constraints:',
      'Errors:',
      'Reference:',
    ])
      expect(fitted).toContain(heading);
    expect(fitted).toContain(`Goal: ${'g'.repeat(300)}`);
    expect(fitted).toContain(`Next: ${'n'.repeat(300)}`);
    expect(fitted).toContain(`Files: ${'f'.repeat(200)}`);
    expect(fitted.match(/shortened to fit/gu)).toHaveLength(2);
  });

  it('cuts Goal and Next too when the other sections cannot make room', () => {
    const fitted = fitSummaryToChars(sections, 400)!;
    expect(fitted.length).toBeLessThanOrEqual(400);
    expect(fitted).toContain('Next:');
  });

  it('closes a code fence the cut left open', () => {
    const fence = '`'.repeat(3);
    const fenced = sections.replace(
      `Reference: ${'r'.repeat(8_000)}`,
      `Reference:\n${fence}ts\n${'const x = 1;\n'.repeat(700)}${fence}`,
    );
    const fitted = fitSummaryToChars(fenced, 4_000)!;
    expect(fitted.length).toBeLessThanOrEqual(4_000);
    expect(fitted.split('\n').filter((line) => line.startsWith(fence)).length % 2).toBe(0);
  });

  it('does not take prose at a line start for a heading', () => {
    const prose = sections.replace(
      `State: ${'s'.repeat(5_000)}`,
      `State: ${'s'.repeat(2_500)}\nNext, run the tests ${'p'.repeat(2_500)}`,
    );
    const fitted = fitSummaryToChars(prose, 4_000)!;
    // Only the real Next is kept whole; the prose line is State's body and is cut.
    expect(fitted).toContain(`Next: ${'n'.repeat(300)}`);
    expect(fitted).not.toContain(`Next, run the tests ${'p'.repeat(2_500)}`);
  });

  it('accepts singular and plural section names and rejects prose ones', () => {
    const plural = [
      '## Goals',
      'Ship it.',
      '## State',
      'Done.',
      '## Next',
      'none.',
      '## File',
      'a.ts',
      '## Constraint',
      'none',
      '## Error',
      'none',
      '## References',
      'none',
    ].join('\n');
    expect(missingSummarySections(plural)).toEqual([]);
    expect(
      missingSummarySections(['Goal: a', 'State of the art', 'Next, run it'].join('\n')),
    ).toEqual(['State', 'Next', 'Files', 'Constraints', 'Errors', 'Reference']);
  });

  it('gives up only when the headings alone do not fit', () => {
    expect(fitSummaryToChars(sections, 20)).toBeUndefined();
  });

  it('subtracts the resume note and its joining blank line from the allowance', () => {
    expect(compactionSummaryAllowance(1_000, '')).toBe(1_000);
    expect(compactionSummaryAllowance(1_000, 'abc')).toBe(995);
  });
});
