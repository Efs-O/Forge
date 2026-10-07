import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import { DEFAULT_TOOL_OUTPUT_LIMITS, toolOutputLimits } from '../../src/tools/toolOutputLimits';
import { renderSearchCodeMatches } from '../../src/tools/searchCodeOutput';
import {
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_CHARS_CEILING,
  parseExecOutputOptions,
} from '../../src/tools/execHelpers';

const compact = { enabled: true, at: 0.85 };
const strata = { name: 'strata', num_ctx: 200_000 } as unknown as ModelConfig;

describe('toolOutputLimits', () => {
  it('scales the Strata limits from its single-slot context window', () => {
    expect(toolOutputLimits(strata, undefined, compact)).toEqual({
      searchLines: 200,
      resultPageChars: 20_000,
      shellInlineChars: 50_000,
      execOutputChars: 30_000,
    });
  });

  it("keeps today's defaults for unknown, unbounded, and four-slot windows", () => {
    const cloud = { name: 'cloud', provider: 'openai' } as unknown as ModelConfig;
    const fourSlots = {
      name: 'small',
      spawn: { num_ctx: 32_768, n_parallel: 4 },
    } as unknown as ModelConfig;
    expect(toolOutputLimits(cloud, undefined, compact)).toEqual(DEFAULT_TOOL_OUTPUT_LIMITS);
    expect(toolOutputLimits(strata, undefined, { enabled: false })).toEqual(
      DEFAULT_TOOL_OUTPUT_LIMITS,
    );
    expect(toolOutputLimits(fourSlots, undefined, compact)).toEqual(DEFAULT_TOOL_OUTPUT_LIMITS);
  });

  it('reports exact omitted search snippets and leaves complete output unchanged', () => {
    const complete = [
      { path: 'a.ts', snippets: ['> 1: hit'], snippetMatches: [true], omittedSnippets: 0 },
    ];
    expect(renderSearchCodeMatches(complete, 50)).toBe('\n=== a.ts ===\n> 1: hit');
    const capped = [
      {
        path: 'a.ts',
        snippets: ['> 1: hit', '> 2: hit'],
        snippetMatches: [true, true],
        omittedSnippets: 3,
      },
      { path: 'b.ts', snippets: ['> 4: hit'], snippetMatches: [true], omittedSnippets: 0 },
    ];
    expect(renderSearchCodeMatches(capped, 50)).toContain('(+3 more matches in this file)');
    expect(renderSearchCodeMatches(capped, 2)).toContain(
      '[Output capped at 2 lines: 5 more matching lines in 1 more file not shown.',
    );
  });

  it('clamps background output to the scaled limit and preserves the fixed ceiling', () => {
    expect(MAX_OUTPUT_CHARS).toBe(16_000);
    expect(MAX_OUTPUT_CHARS_CEILING).toBe(32_000);
    expect(parseExecOutputOptions({ max_output_chars: 20_000 }, 18_000)).toMatchObject({
      maxChars: 18_000,
      maxCharsExplicit: true,
      maxCharsClamped: true,
    });
    expect(parseExecOutputOptions({}, 30_000)).toMatchObject({ maxChars: 30_000 });
    expect(() => parseExecOutputOptions({ max_output_chars: 32_001 }, 30_000)).toThrow();
  });
});
