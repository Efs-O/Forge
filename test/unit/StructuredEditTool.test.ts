import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyLineEditsToContent,
  makeApplyLineEditsTool,
} from '../../src/tools/structuredEditTool';
import { coerceToolArgs } from '../../src/tools/argCoercion';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
}));

describe('apply_line_edits', () => {
  it('applies ordered edits atomically from the bottom and preserves CRLF', () => {
    const result = applyLineEditsToContent('one\r\ntwo\r\nthree\r\nfour\r\n', [
      {
        start_line: 1,
        end_line: 1,
        expected_lines: ['one'],
        replacement_lines: ['ONE'],
      },
      {
        start_line: 3,
        end_line: 4,
        expected_lines: ['three', 'four'],
        replacement_lines: ['THREE'],
      },
    ]);
    expect(result).toEqual({
      content: 'ONE\r\ntwo\r\nTHREE\r\n',
      replacedLines: 3,
      replacementLines: 2,
    });
  });

  it('rejects stale expected content before producing an edit', () => {
    expect(() =>
      applyLineEditsToContent('current\n', [
        {
          start_line: 1,
          end_line: 1,
          expected_lines: ['old'],
          replacement_lines: ['new'],
        },
      ]),
    ).toThrow('is stale');
  });

  it('reports the original one-based index when the third operation is stale', () => {
    expect(() =>
      applyLineEditsToContent('a\nb\nc\nd\ne\nf', [
        { start_line: 1, end_line: 1, expected_lines: ['a'], replacement_lines: ['A'] },
        { start_line: 3, end_line: 3, expected_lines: ['c'], replacement_lines: ['C'] },
        { start_line: 5, end_line: 5, expected_lines: ['wrong'], replacement_lines: ['E'] },
      ]),
    ).toThrow('apply_line_edits: operation 3 is stale');
  });

  it('sorts out-of-order operations and names overlapping operation ranges', () => {
    expect(
      applyLineEditsToContent('a\nb\nc', [
        { start_line: 3, end_line: 3, expected_lines: ['c'], replacement_lines: ['C'] },
        { start_line: 1, end_line: 1, expected_lines: ['a'], replacement_lines: ['A'] },
      ]).content,
    ).toBe('A\nb\nC');
    expect(() =>
      applyLineEditsToContent('a\nb\nc', [
        { start_line: 2, end_line: 2, expected_lines: ['b'], replacement_lines: ['B'] },
        { start_line: 2, end_line: 3, expected_lines: ['b', 'c'], replacement_lines: ['C'] },
      ]),
    ).toThrow('operation 1 lines 2-2 overlaps operation 2 lines 2-3');
    expect(() =>
      applyLineEditsToContent('a\n', [
        { start_line: 2, end_line: 2, expected_lines: [''], replacement_lines: ['b'] },
      ]),
    ).toThrow('out-of-range');
  });

  it('names the given and required line counts and the range when they disagree', () => {
    expect(() =>
      applyLineEditsToContent('a\nb\nc\nd\n', [
        { start_line: 2, end_line: 4, expected_lines: ['b', 'c'], replacement_lines: ['B'] },
      ]),
    ).toThrow('operation 1 expected_lines has 2 line(s), but lines 2-4 are 3 line(s)');
    expect(() =>
      applyLineEditsToContent('a\nb\nc\nd\n', [
        { start_line: 2, end_line: 4, expected_lines: ['b', 'c'], replacement_lines: ['B'] },
      ]),
    ).toThrow('Current file lines 2-4:\n2|b\n3|c\n4|d');
  });

  it('derives one omitted bound from expected_lines when dispatching the tool', async () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.forge-line-edit-bounds-'));
    const filePath = path.join(directory, 'sample.ts');
    const relativePath = path.relative(process.cwd(), filePath);
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n', 'utf8');
    const tool = makeApplyLineEditsTool();
    try {
      await expect(
        tool.handler({
          path: relativePath,
          operations: [
            { start_line: 2, expected_lines: ['two'], replacement_lines: ['TWO'] },
          ],
        }),
      ).resolves.toContain('"operationsApplied":1');
      await expect(
        tool.handler({
          path: relativePath,
          operations: [
            { end_line: 3, expected_lines: ['three'], replacement_lines: ['THREE'] },
          ],
        }),
      ).resolves.toContain('"operationsApplied":1');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('one\nTWO\nTHREE\n');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects no-op operations', () => {
    expect(() =>
      applyLineEditsToContent('same', [
        { start_line: 1, end_line: 1, expected_lines: ['same'], replacement_lines: ['same'] },
      ]),
    ).toThrow('would not change');
  });

  it('rejects mixed line endings instead of normalizing unrelated lines', () => {
    expect(() =>
      applyLineEditsToContent('one\r\ntwo\n', [
        { start_line: 1, end_line: 1, expected_lines: ['one'], replacement_lines: ['ONE'] },
      ]),
    ).toThrow('mixed or bare-CR');
  });

  it('enforces operation-count and cumulative replacement budgets', () => {
    const repeated = Array.from({ length: 21 }, (_, index) => ({
      start_line: index + 1,
      end_line: index + 1,
      expected_lines: ['a'],
      replacement_lines: ['b'],
    }));
    expect(() => applyLineEditsToContent(Array(21).fill('a').join('\n'), repeated)).toThrow(
      '1-20 entries',
    );

    expect(() =>
      applyLineEditsToContent(Array(17).fill('a').join('\n'), [
        {
          start_line: 1,
          end_line: 17,
          expected_lines: Array(17).fill('a'),
          replacement_lines: Array(17).fill('x'.repeat(4_000)),
        },
      ]),
    ).toThrow('replacements exceed 64000 characters');
  });

  it('publishes a strict schema and exact mutation metadata', () => {
    const tool = makeApplyLineEditsTool();
    const schema = tool.definition.function.parameters;
    expect(schema.additionalProperties).toBe(false);
    // `path` is not required: the tool can read it from operations that all name
    // the same file, and `ToolRegistry.invalidArgs` must not refuse the call
    // before that lift happens (docs/plans/V1_FINISH_PLAN.md lane 5 phase 5.5).
    expect(schema.required).toEqual(['operations']);
    expect(tool.mutation?.paths({ path: 'src/a.ts', operations: [] })).toEqual(['src/a.ts']);
  });

  it('writes once after validation and leaves stale files unchanged', async () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.forge-line-edit-test-'));
    const filePath = path.join(directory, 'sample.ts');
    const relativePath = path.relative(process.cwd(), filePath);
    fs.writeFileSync(filePath, 'const value = 1;\n', 'utf8');
    const tool = makeApplyLineEditsTool();
    try {
      await expect(
        tool.handler({
          path: relativePath,
          operations: [
            {
              start_line: 1,
              end_line: 1,
              expected_lines: ['const value = 1;'],
              replacement_lines: ['const value = 2;'],
            },
          ],
        }),
      ).resolves.toContain('"operationsApplied":1');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('const value = 2;\n');

      await expect(
        tool.handler({
          path: relativePath,
          operations: [
            {
              start_line: 1,
              end_line: 1,
              expected_lines: ['const value = 1;'],
              replacement_lines: ['const value = 3;'],
            },
          ],
        }),
      ).rejects.toThrow('is stale');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('const value = 2;\n');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * Lane 5 phase 5.5 (docs/plans/V1_FINISH_PLAN.md): six of 81 audited
 * `apply_line_edits` calls named the file inside every operation instead of once
 * at the top and were refused for a `path` the tool could read from the
 * operations it already had. The lift is safe only because this tool edits one
 * file per call, so operations naming different files are refused by name rather
 * than guessed, and the checkpoint has to see the lifted file or the write is
 * unrecoverable.
 */
describe('the file named inside the operations', () => {
  const context = { beforeMutate: vi.fn() };

  function fixture(contents = 'one\ntwo\nthree\n'): {
    tool: ReturnType<typeof makeApplyLineEditsTool>;
    relative: string;
    file: string;
    cleanup: () => void;
  } {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.forge-line-lift-'));
    const file = path.join(directory, 'sample.ts');
    fs.writeFileSync(file, contents, 'utf8');
    return {
      tool: makeApplyLineEditsTool(),
      relative: path.relative(process.cwd(), file),
      file,
      cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
  }

  it('lifts a path every operation repeats, lands the edit, and says it happened', async () => {
    const { tool, relative, file, cleanup } = fixture();
    try {
      const result = String(
        await tool.handler(
          {
            operations: [
              {
                path: relative,
                start_line: 1,
                end_line: 1,
                expected_lines: ['one'],
                replacement_lines: ['ONE'],
              },
              {
                path: relative,
                start_line: 3,
                end_line: 3,
                expected_lines: ['three'],
                replacement_lines: ['THREE'],
              },
            ],
          },
          context,
        ),
      );
      expect(result).toContain('"operationsApplied":2');
      expect(result).toContain('No "path" at the top level');
      expect(result).toContain(`("${relative}")`);
      expect(fs.readFileSync(file, 'utf8')).toBe('ONE\ntwo\nTHREE\n');
    } finally {
      cleanup();
    }
  });

  it('lifts even when one operation says nothing about the file', async () => {
    // An operation with no path does not disagree with the one that named the
    // file; refusing here would punish the call for the shape it was being told
    // to use, and nothing about which file to edit is in question.
    const { tool, relative, file, cleanup } = fixture();
    try {
      const result = String(
        await tool.handler(
          {
            operations: [
              {
                path: relative,
                start_line: 1,
                end_line: 1,
                expected_lines: ['one'],
                replacement_lines: ['ONE'],
              },
              {
                start_line: 2,
                end_line: 2,
                expected_lines: ['two'],
                replacement_lines: ['TWO'],
              },
            ],
          },
          context,
        ),
      );
      expect(result).toContain('No "path" at the top level');
      expect(fs.readFileSync(file, 'utf8')).toBe('ONE\nTWO\nthree\n');
    } finally {
      cleanup();
    }
  });

  it('refuses operations that name different files, by name, and writes nothing', async () => {
    const { tool, relative, file, cleanup } = fixture();
    const other = relative.replace('sample.ts', 'other.ts');
    try {
      let refusal = '';
      try {
        await tool.handler(
          {
            operations: [
              {
                path: relative,
                start_line: 1,
                end_line: 1,
                expected_lines: ['one'],
                replacement_lines: ['ONE'],
              },
              {
                path: other,
                start_line: 2,
                end_line: 2,
                expected_lines: ['two'],
                replacement_lines: ['TWO'],
              },
            ],
          },
          context,
        );
      } catch (error) {
        refusal = (error as Error).message;
      }
      expect(refusal).toContain('edits one file per call');
      // Both files are named, so the model can see which operations disagree.
      expect(refusal).toContain(relative);
      expect(refusal).toContain(other);
      expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');
    } finally {
      cleanup();
    }
  });

  it('checkpoints the lifted file, and nothing when the call cannot be resolved', () => {
    const tool = makeApplyLineEditsTool();
    expect(tool.mutation?.paths({ operations: [{ path: 'src/a.ts' }, { path: 'src/a.ts' }] })).toEqual(
      ['src/a.ts'],
    );
    // A call that will be refused snapshots nothing: the handler writes nothing,
    // so a snapshot of `undefined` would only add a bogus checkpoint.
    expect(tool.mutation?.paths({ operations: [{ path: 'a.ts' }, { path: 'b.ts' }] })).toEqual([]);
    expect(tool.mutation?.paths({ operations: [{ start_line: 1 }] })).toEqual([]);
  });

  it('operations arriving as a JSON string still lift, because the registry parses first', async () => {
    // The ordering the plan asked to confirm: `coerceToolArgs` turns a string
    // array into an array in `ToolDispatch` before `invalidArgs` and before this
    // handler, so the lift sees parsed operations, never a string to guess at.
    const { tool, relative, file, cleanup } = fixture();
    try {
      const coerced = coerceToolArgs(tool.definition, {
        operations: JSON.stringify([
          {
            path: relative,
            start_line: 1,
            end_line: 1,
            expected_lines: ['one'],
            replacement_lines: ['ONE'],
          },
        ]),
      });
      expect(Array.isArray(coerced['operations'])).toBe(true);
      const result = String(await tool.handler(coerced, context));
      expect(result).toContain('No "path" at the top level');
      expect(fs.readFileSync(file, 'utf8')).toBe('ONE\ntwo\nthree\n');
    } finally {
      cleanup();
    }
  });

  it('a call with no file named anywhere shows the shape it needs', async () => {
    const { tool, file, cleanup } = fixture();
    try {
      await expect(
        tool.handler(
          {
            operations: [
              { start_line: 1, end_line: 1, expected_lines: ['one'], replacement_lines: ['ONE'] },
            ],
          },
          context,
        ),
      ).rejects.toThrow('Accepted shape: { "path": "..."');
      expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');
    } finally {
      cleanup();
    }
  });
});
