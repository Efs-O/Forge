import { describe, expect, it } from 'vitest';
import { capSnippetLine, MAX_SNIPPET_CHARS } from '../../src/tools/searchSnippet';

describe('capSnippetLine', () => {
  it('returns a normal source line byte-identical', () => {
    const line = '  const budget = computeContextBudget({ messages, model });';
    expect(capSnippetLine(line, 8)).toBe(line);
  });

  it('keeps the searched term visible in a minified line', () => {
    // The regression this exists for: a head-only cut of a 1.7 MB JSON line
    // showed the model everything except the term it searched for.
    const line = `${'x'.repeat(200_000)}NEEDLE${'y'.repeat(200_000)}`;
    const capped = capSnippetLine(line, 200_000);

    expect(capped).toContain('NEEDLE');
    expect(capped).toContain('[line is 400006 chars');
  });

  it('bounds the payload to the cap regardless of line size', () => {
    const capped = capSnippetLine('z'.repeat(1_000_000), 500_000);
    const payload = capped.slice(0, capped.indexOf(' [line is'));
    expect(payload.replace(/…/g, '').length).toBe(MAX_SNIPPET_CHARS);
  });

  it('keeps the head when there is no submatch (context lines)', () => {
    const line = `HEAD${'q'.repeat(10_000)}`;
    expect(capSnippetLine(line)).toContain('HEAD');
  });

  it('does not run past the end when the match is at the tail', () => {
    const line = `${'a'.repeat(5_000)}TAILMATCH`;
    const capped = capSnippetLine(line, 5_000);
    expect(capped).toContain('TAILMATCH');
  });
});
