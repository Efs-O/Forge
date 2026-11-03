import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import { DEFAULT_TOOL_OUTPUT_LIMITS, toolOutputLimits } from '../../src/tools/toolOutputLimits';
import {
  renderSearchCodeCounts,
  renderSearchCodeMatches,
  renderSearchCodePaths,
} from '../../src/tools/searchCodeOutput';
import {
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_CHARS_CEILING,
  parseExecOutputOptions,
} from '../../src/tools/execHelpers';

const compact = { enabled: true, at: 0.85 };
const strata = { name: 'strata', num_ctx: 200_000 } as unknown as ModelConfig;

describe('toolOutputLimits', () => {
  it('scales the Strata limits from its single-slot context window', () => {
    expect(toolOutputLimits(strata, undefined, compact, 'openai-compatible')).toEqual({
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
    expect(toolOutputLimits(cloud, undefined, compact, 'openai')).toEqual(DEFAULT_TOOL_OUTPUT_LIMITS);
    expect(toolOutputLimits(strata, undefined, { enabled: false }, 'openai-compatible')).toEqual(
      DEFAULT_TOOL_OUTPUT_LIMITS,
    );
    expect(toolOutputLimits(fourSlots, undefined, compact, 'llama.cpp')).toEqual(
      DEFAULT_TOOL_OUTPUT_LIMITS,
    );
  });

  const complete = [
    {
      path: 'a.ts',
      snippets: ['> 1: hit'],
      snippetMatches: [true],
      omittedSnippets: 0,
      matchCount: 1,
    },
  ];
  const capped = [
    {
      path: 'a.ts',
      snippets: ['> 1: hit', '> 2: hit'],
      snippetMatches: [true, true],
      omittedSnippets: 3,
      matchCount: 5,
    },
    {
      path: 'b.ts',
      snippets: ['> 4: hit'],
      snippetMatches: [true],
      omittedSnippets: 0,
      matchCount: 1,
    },
  ];

  it('reports exact omitted search snippets and leaves complete output unchanged', () => {
    expect(renderSearchCodeMatches(complete, 50)).toBe('\n=== a.ts ===\n> 1: hit');
    expect(renderSearchCodeMatches(capped, 50)).toContain('(+3 more matches in this file)');
    expect(renderSearchCodeMatches(capped, 2)).toContain(
      '[Output capped at 2 lines: 5 more matching lines in 1 more file not shown.',
    );
  });

  // The budget is the number of lines the caller asked for, and the
  // "N more matches in this file" line is a line like any other. It used to be
  // pushed after the snippet loop ran out of room, so the answer came back one
  // line over the limit. With no room for it, its count belongs to the cap
  // announcement instead — which is what the second assertion checks.
  it('keeps the match output inside the line budget instead of going one over', () => {
    expect(renderSearchCodeMatches(capped, 2)).toBe(
      '\n=== a.ts ===\n> 1: hit\n' +
        '[Output capped at 2 lines: 5 more matching lines in 1 more file not shown. ' +
        'Narrow with an include glob or a more specific query.]',
    );
    expect(renderSearchCodeMatches(capped, 2)).not.toContain('(+3 more matches in this file)');
  });

  // A file whose stored snippets all fit but whose extra matches were never
  // kept: suppressing the note must not make those matches disappear without
  // anyone saying they were there.
  it('counts the matches a suppressed note was carrying', () => {
    const fitted = [
      {
        path: 'a.ts',
        snippets: ['> 1: hit', '> 2: hit'],
        snippetMatches: [true, true],
        omittedSnippets: 3,
        matchCount: 5,
      },
    ];
    expect(renderSearchCodeMatches(fitted, 3)).toBe(
      '\n=== a.ts ===\n> 1: hit\n> 2: hit\n' +
        '[Output capped at 3 lines: 3 more matching lines in 0 more files not shown. ' +
        'Narrow with an include glob or a more specific query.]',
    );
  });

  // The path and count lists answer "where do I look next", so a file cut off by
  // the line budget has to be named as missing, or the caller reads a short list
  // as the whole search.
  it('caps the path and count lists at the same line budget and names what it cut', () => {
    const files = [
      { path: 'a.ts', snippets: [], snippetMatches: [], omittedSnippets: 0, matchCount: 3 },
      { path: 'b.ts', snippets: [], snippetMatches: [], omittedSnippets: 0, matchCount: 1 },
    ];
    expect(renderSearchCodePaths(files, 50)).toBe('a.ts\nb.ts');
    expect(renderSearchCodeCounts(files, 50)).toBe('a.ts:3\nb.ts:1');
    expect(renderSearchCodePaths(files, 1)).toContain(
      '[Output capped at 1 lines: 1 more matching file not shown.',
    );
    expect(renderSearchCodeCounts(files, 1)).toBe(
      'a.ts:3\n[Output capped at 1 lines: 1 more matching file not shown. ' +
        'Narrow with an include glob or a more specific query.]',
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
