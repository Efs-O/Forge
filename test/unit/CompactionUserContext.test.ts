import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import { compactionBudget, withFirstRequestAllowance } from '../../src/sidebar/compactionBudget';
import { compactionSummaryAllowance } from '../../src/sidebar/compactionSummaryRunner';
import {
  collectCompactionUserMessages,
  FIRST_REQUEST_MAX_CHARS,
  firstRequestExtraChars,
  renderCompactionUserMessages,
  USER_CONTEXT_MAX_CHARS,
  USER_CONTEXT_MAX_MESSAGES,
  USER_CONTEXT_MESSAGE_MAX_CHARS,
} from '../../src/sidebar/compactionUserContext';

describe('compaction user context', () => {
  it('keeps user-authored decisions but excludes Forge continuation prompts', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'build the workflow' },
      { role: 'user', content: 'Continue the active task.', internal: true },
      { role: 'user', content: 'keep the fixed-camera version' },
    ];

    expect(collectCompactionUserMessages(undefined, messages)).toEqual([
      'build the workflow',
      'keep the fixed-camera version',
    ]);
  });

  it('deduplicates repeated requests across compaction generations', () => {
    const collected = collectCompactionUserMessages(
      ['original request', 'use model A'],
      [
        { role: 'user', content: 'use model A' },
        { role: 'user', content: 'switch to model B' },
      ],
    );

    expect(collected).toEqual(['original request', 'use model A', 'switch to model B']);
    expect(renderCompactionUserMessages(collected)).toContain('[3] switch to model B');
  });

  it('always keeps the original request and fills bounded room newest-first', () => {
    const messages: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: 'user' as const,
      content: `${index}: ${'x'.repeat(600)}`,
    }));

    const collected = collectCompactionUserMessages(undefined, messages);
    expect(collected[0]).toContain('0:');
    expect(collected.at(-1)).toContain('39:');
    expect(collected.length).toBeLessThanOrEqual(USER_CONTEXT_MAX_MESSAGES);
    // The first request has its own allowance; the rest share USER_CONTEXT_MAX_CHARS.
    expect(
      collected.slice(1).reduce((sum, message) => sum + message.length, 0),
    ).toBeLessThanOrEqual(USER_CONTEXT_MAX_CHARS);
  });

  it('marks the block as answered history so the newest entry is not read as a new request', () => {
    const rendered = renderCompactionUserMessages([
      'benchmark the minimal arm',
      'It errored again man - tell claude to investigate and fix it',
    ]);

    // Deliberately not "already finished": a compaction can fire mid-turn, and
    // telling the agent the newest request was completed ends the task early.
    expect(rendered).not.toContain('already been acted on and reported');

    expect(rendered).toContain('ALREADY RECEIVED');
    expect(rendered).toContain('[2] is the most recent of them, NOT a new request');
    expect(rendered).toContain('read the State and Next of the summary');
    expect(rendered).not.toContain('[3]');
  });

  it('omits the most-recent callout when there is only one entry to confuse', () => {
    const rendered = renderCompactionUserMessages(['the only request']);

    expect(rendered).toContain('[1] the only request');
    expect(rendered).not.toContain('NOT a new request');
  });

  it('renders nothing when no user context survived', () => {
    expect(renderCompactionUserMessages([])).toBe('');
    expect(renderCompactionUserMessages(undefined)).toBe('');
  });

  it('trims the rendered block to the host budget while keeping the per-message ceiling', () => {
    const rendered = renderCompactionUserMessages(
      ['first '.repeat(700), 'latest '.repeat(700)],
      5_000,
    );
    expect(rendered.length).toBeLessThanOrEqual(5_000);
    expect(rendered).toContain('VERBATIM USER REQUESTS');
    expect(rendered).toContain('[user message truncated]');
  });

  it('keeps a short newest request whole when the first request is long', () => {
    const newest = 'latest correction: keep the current fix';
    const rendered = renderCompactionUserMessages(['first '.repeat(1_000), newest], 5_000);

    expect(rendered).toContain(`[2] ${newest}`);
  });

  it('keeps a long first request whole up to its own allowance', () => {
    // The jelly-press task prompt was 5,710 characters; the 4,000 cap cut its last third.
    const first = `spec ${'s'.repeat(5_705)}`;
    const collected = collectCompactionUserMessages(undefined, [
      { role: 'user', content: first },
      { role: 'user', content: 'later' },
    ]);
    expect(collected[0]).toBe(first);

    const huge = collectCompactionUserMessages(undefined, [
      { role: 'user', content: 'h'.repeat(20_000) },
    ]);
    expect(huge[0]!.startsWith('h'.repeat(FIRST_REQUEST_MAX_CHARS))).toBe(true);
    expect(huge[0]!.length).toBeLessThan(FIRST_REQUEST_MAX_CHARS + 100);
  });

  it('gives later requests their full budget regardless of the first request', () => {
    const later = (first: string): string[] =>
      collectCompactionUserMessages(undefined, [
        { role: 'user', content: first },
        ...Array.from({ length: 10 }, (_, index) => ({
          role: 'user' as const,
          content: `${index}: ${'y'.repeat(1_500)}`,
        })),
      ]).slice(1);

    const afterShort = later('short');
    const afterLong = later('z'.repeat(FIRST_REQUEST_MAX_CHARS));
    expect(afterLong).toEqual(afterShort);
    expect(afterLong.reduce((sum, message) => sum + message.length, 0)).toBeGreaterThan(
      USER_CONTEXT_MAX_CHARS - 1_600,
    );
    expect(renderCompactionUserMessages(['z'.repeat(FIRST_REQUEST_MAX_CHARS), ...afterLong])).toContain(
      afterLong.at(-1)!,
    );
  });

  it('grows the host and replacement budgets together, so the summary allowance is unchanged', () => {
    const extra = firstRequestExtraChars(['f'.repeat(9_000), 'later']);
    expect(extra).toBe(9_000 - USER_CONTEXT_MESSAGE_MAX_CHARS);
    expect(firstRequestExtraChars(['short'])).toBe(0);

    const base = compactionBudget(64_000, 400_000, 131_072, 4_096);
    const grown = withFirstRequestAllowance(base, extra);
    expect(grown.hostMaxChars).toBe(base.hostMaxChars + extra);
    expect(grown.replacementMaxChars).toBe(base.replacementMaxChars + extra);
    expect(grown.summaryCeilingChars).toBe(base.summaryCeilingChars);
    const floor = 3_000;
    expect(
      compactionSummaryAllowance(grown.summaryCeilingChars, grown.replacementMaxChars, floor + extra, ''),
    ).toBe(compactionSummaryAllowance(base.summaryCeilingChars, base.replacementMaxChars, floor, ''));
  });
});
