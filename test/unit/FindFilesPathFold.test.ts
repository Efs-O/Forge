import { describe, expect, it } from 'vitest';
import { ToolRegistry, type RegisteredTool } from '../../src/tools/ToolRegistry';
import { makeFindFilesTool } from '../../src/tools/dirTools';

/**
 * A model reaches for a folder argument on a find tool, because most agent tool
 * sets have one. `find_files` has none: its `pattern` is anchored at the
 * workspace root, and a folder is a prefix of the pattern that means the same
 * search. Measured 2026-11-18: a laptop test on 0.17.195 sent
 * `{"pattern":"*","path":"."}`, was refused, and spent a round resending a call
 * that had already been understood. These cases pin the fold that replaced that
 * refusal, and the shapes that still refuse.
 */
describe('find_files path folded into the pattern', () => {
  const registry = new ToolRegistry();
  const findFiles: RegisteredTool = makeFindFilesTool();

  /** One call, what it becomes, and whether the tool then runs. */
  type FoldCase = [
    label: string,
    input: Record<string, unknown>,
    expected: Record<string, unknown>,
    refused: boolean,
  ];

  const cases: FoldCase[] = [
    [
      'the workspace root named as a folder',
      { pattern: '*', path: '.' },
      { pattern: '*' },
      false,
    ],
    ['a nested folder', { pattern: '*.ts', path: 'src' }, { pattern: 'src/*.ts' }, false],
    [
      'a folder written with ./ and a trailing slash',
      { pattern: '**/*.md', path: './docs/' },
      { pattern: 'docs/**/*.md' },
      false,
    ],
    [
      'a folder with Windows separators',
      { pattern: '*.png', path: 'smoke-195\\out' },
      { pattern: 'smoke-195/out/*.png' },
      false,
    ],
    [
      'a folder and no pattern at all',
      { path: 'smoke-195' },
      { pattern: 'smoke-195/**' },
      false,
    ],
    ['the root with no pattern', { path: '.' }, { pattern: '**/*' }, false],
    [
      'an absolute folder',
      { pattern: '*', path: 'C:/Users/x' },
      { pattern: '*', path: 'C:/Users/x' },
      true,
    ],
    [
      'a folder escaping the workspace',
      { pattern: '*', path: '../other' },
      { pattern: '*', path: '../other' },
      true,
    ],
    ['a unix absolute folder', { pattern: '*', path: '/etc' }, { pattern: '*', path: '/etc' }, true],
    ['a folder that is not a string', { pattern: '*', path: 3 }, { pattern: '*', path: 3 }, true],
  ];

  it.each(cases)('folds or leaves %s', (_label, input, expected, refused) => {
    const args: Record<string, unknown> = { ...input };
    const refusal = registry.invalidArgs(findFiles, args);
    expect(args).toEqual(expected);
    if (refused) expect(refusal).toContain('unknown argument "path"');
    else expect(refusal).toBeUndefined();
  });

  // The fold is a repair for a tool that has no folder argument. Give `find_files`
  // a real one and the fold must stand down rather than fold a folder twice.
  it('stands down when find_files declares a path argument of its own', () => {
    const withPath: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: 'find_files',
          description: 'Find files.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      },
      permission: 'read',
      handler: async () => 'unused',
    };
    const args: Record<string, unknown> = { pattern: '*.ts', path: 'src' };
    expect(registry.invalidArgs(withPath, args)).toBeUndefined();
    expect(args).toEqual({ pattern: '*.ts', path: 'src' });
  });

  // The refusal text is pinned whole, in the code's own words: a weak model
  // reads one quoted key as an argument to resend verbatim and burns the round
  // again. The escaping folder is the shape the fold must never guess at.
  it('still refuses a folder that cannot be a pattern prefix, in the existing words', () => {
    expect(registry.invalidArgs(findFiles, { pattern: '*', path: '../other' })).toBe(
      'Error: find_files: unknown argument "path"; this tool takes: pattern, max_results, include_ignored. ' +
        'Nothing ran. Resend the call without it, or use the argument that means what you intended.',
    );
  });
});
