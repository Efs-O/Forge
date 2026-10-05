import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import { compactionBudget, planOutput } from '../../src/sidebar/compactionBudget';
import { summarizeCompaction } from '../../src/sidebar/compactionSummaryRunner';
import { PromptIncompleteError } from '../../src/sidebar/PromptRun';
import type { PromptRunOptions } from '../../src/sidebar/PromptRun';

const note = `Goal: finish the audit.
State: the earlier finding was corrected with evidence.
Next: continue the approved task.
Files: src/a.ts.
Constraints: the prior pause applied to the audit only.
Errors: none unresolved. ${'Evidence. '.repeat(30)}`;

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
    budget: compactionBudget(170_000, 400_000, 200_000),
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

  it('budgets 200k and synthetic 400k slots at 6% target and 12% replacement', () => {
    const twoHundred = compactionBudget(170_000, 400_000, 200_000);
    expect(twoHundred.summaryTargetTokens).toBe(10_200);
    expect(twoHundred.replacementMaxChars).toBe(51_000);
    const fourHundred = compactionBudget(340_000, 850_000, 400_000);
    expect(fourHundred.summaryTargetTokens).toBe(20_400);
    expect(fourHundred.replacementMaxChars).toBe(102_000);
    expect(planOutput(10_000, 0, 32_768)).toEqual({ outputTokens: 10_000, requestCap: 10_000 });
  });
});
