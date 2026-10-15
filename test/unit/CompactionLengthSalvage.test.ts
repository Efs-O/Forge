import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import { compactionBudget } from '../../src/sidebar/compactionBudget';
import {
  buildSummaryPrompt,
  LENGTH_CUT_MARKER,
  missingSummarySections,
  salvageCutSummary,
} from '../../src/sidebar/compactionPrompt';
import {
  summarizeCompaction,
  summaryOutputTokens,
} from '../../src/sidebar/compactionSummaryRunner';
import { PromptIncompleteError, type PromptRunOptions } from '../../src/sidebar/PromptRun';

const head = `Goal: finish the audit.
State: the earlier finding was corrected with evidence.
Next: continue the approved task.
Files: src/a.ts.
Constraints: the prior pause applied to the audit only.
Errors: none unresolved.
Reference:
- export function audit(input: AuditInput): Promise<AuditResult> // src/a.ts:12
- export function fix(input: FixInput): Promise<void> // src/a.ts:48
`;
/** A summary the output cap ended halfway through a Reference line. */
const cutOff = `${head}- export function verify(inp`;

const messages: ChatMessage[] = [
  { role: 'user', content: 'Audit the code.' },
  { role: 'assistant', content: 'Found a race in src/a.ts.' },
  { role: 'user', content: 'Implement the approved fix.' },
];

function input(runPrompt: (text: string, id: string, options: PromptRunOptions) => Promise<string>) {
  return {
    messages,
    currentLocalTime: 'test local time',
    recordedFacts: 'Command completed successfully.',
    userContext: 'Audit the code.',
    modelName: 'strata',
    modelMaxTokens: 200_000,
    outputLimitTokens: 32_768,
    reasoningTokens: 0,
    budget: compactionBudget(170_000, 400_000, 200_000, 0, 2.66, 200_000),
    maximumSummaryChars: 35_000,
    conversationId: 'c1',
    runPrompt,
  };
}

const lengthStop = (partial?: string) =>
  vi.fn(async (_text: string, _id: string, _options: PromptRunOptions): Promise<string> => {
    throw new PromptIncompleteError('length', partial);
  });

describe('summary output cap', () => {
  it('leaves room past the character allowance, so an overshoot is cut, not stopped', async () => {
    const runPrompt = vi.fn(async (_t: string, _i: string, _o: PromptRunOptions) => head);
    const request = input(runPrompt);
    await summarizeCompaction(request);
    const options = runPrompt.mock.calls[0]![2];
    const allowanceTokens = request.maximumSummaryChars / request.budget.charsPerToken;
    expect(options.outputTokens).toBeGreaterThanOrEqual(allowanceTokens * 1.4);
    expect(options).toMatchObject({ requireComplete: true, partialOnIncomplete: true });
  });

  it('adds at least 4000 tokens, or half the allowance when that is more', () => {
    expect(summaryOutputTokens(10_000, 2.5, 200_000)).toBe(4_000 + 4_000);
    expect(summaryOutputTokens(50_000, 2.5, 400_000)).toBe(20_000 + 10_000);
  });

  it('keeps the headroom within a tenth of a small window', () => {
    expect(summaryOutputTokens(10_000, 2.5, 20_000)).toBe(4_000 + 2_000);
    expect(summaryOutputTokens(10_000, 2.5, 0)).toBe(4_000 + 4_000);
  });
});

describe('salvaging a summary the output cap ended', () => {
  it('keeps every heading, drops the unfinished line and marks the cut', async () => {
    const result = await summarizeCompaction(input(lengthStop(cutOff)));
    expect(result.salvagedFromLength).toBe(true);
    expect(missingSummarySections(result.summary)).toEqual([]);
    expect(result.summary).toContain('src/a.ts:48');
    expect(result.summary).not.toContain('verify(inp');
    expect(result.summary.endsWith(LENGTH_CUT_MARKER)).toBe(true);
  });

  it('reports the length failure when a heading never got written', async () => {
    const noReference = `${head.slice(0, head.indexOf('Reference:'))}- more state that ran on and on`;
    await expect(summarizeCompaction(input(lengthStop(noReference)))).rejects.toThrow(
      /finish_reason=length/u,
    );
  });

  it('reports the length failure when the last section was barely started', async () => {
    const barely = `${head.slice(0, head.indexOf('Reference:'))}Reference:\n- exp`;
    await expect(summarizeCompaction(input(lengthStop(barely)))).rejects.toThrow(
      /finish_reason=length/u,
    );
  });

  it('reports the length failure when no partial text was attached', async () => {
    await expect(summarizeCompaction(input(lengthStop()))).rejects.toThrow(/finish_reason=length/u);
  });

  it('does not salvage a cut with any other finish reason', async () => {
    const runPrompt = vi.fn(async (_t: string, _i: string, _o: PromptRunOptions): Promise<string> => {
      throw new PromptIncompleteError(null, cutOff);
    });
    await expect(summarizeCompaction(input(runPrompt))).rejects.toBeInstanceOf(
      PromptIncompleteError,
    );
  });

  it('closes a code fence the cut left open', () => {
    const fenced = `${head}\`\`\`ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d =`;
    const kept = salvageCutSummary(fenced, 10_000)!;
    const body = kept.slice(0, -LENGTH_CUT_MARKER.length);
    expect(body.split('\n').filter((line) => line.startsWith('```')).length % 2).toBe(0);
    expect(body).not.toContain('const d =');
  });

  it('fits an over-long cut to the allowance and keeps the marker last', () => {
    const long = `${head}${'- export function step(): void // src/b.ts:1\n'.repeat(400)}- unfin`;
    const kept = salvageCutSummary(long, 4_000)!;
    expect(kept.length).toBeLessThanOrEqual(4_000);
    expect(missingSummarySections(kept)).toEqual([]);
    expect(kept.endsWith(LENGTH_CUT_MARKER)).toBe(true);
  });
});

describe('section order', () => {
  // Salvage relies on the cut falling in the last section; the prompt has to
  // name Reference last for that to be the section that is safe to lose.
  it('asks for the headings in the checked order, with Reference last', () => {
    const prompt = buildSummaryPrompt('now', undefined, messages, '', '', undefined, {
      sourceMaxChars: 10_000,
      summaryMaxChars: 5_000,
      previousSummaryMaxChars: 5_000,
    });
    const listed = /Use all seven headings: ([^.]+)\./u.exec(prompt)?.[1]?.split(', ');
    const checked = missingSummarySections('');
    expect(listed).toEqual(checked);
    expect(checked.at(-1)).toBe('Reference');
  });
});
