import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as atomicWrite from '../../src/util/atomicWrite';
import {
  applyLineEditsToContent,
  makeApplyLineEditsTool,
} from '../../src/tools/structuredEditTool';
import { splitEditTextLines } from '../../src/tools/lineEditText';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
}));

describe('apply_line_edits', () => {
  it('names the absolute target, given path, workspace root, and creation tool when missing', async () => {
    const missing = path.join(process.cwd(), `line-edit-missing-${process.pid}.txt`);
    await expect(
      makeApplyLineEditsTool().handler({
        path: missing,
        operations: [
          { start_line: 1, end_line: 1, expected_text: 'before', replacement_text: 'after' },
        ],
      }),
    ).rejects.toThrow(
      `apply_line_edits: no file at ${missing} (the path "${missing}" resolved against the workspace root ${process.cwd()}). apply_line_edits changes an existing file only: to create it, use write_file; to look for it, use find_files.`,
    );
  });

  it('keeps the existing message for a non-ENOENT read error', async () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.forge-line-edit-read-error-'));
    try {
      await expect(
        makeApplyLineEditsTool().handler({
          path: directory,
          operations: [
            { start_line: 1, end_line: 1, expected_text: 'before', replacement_text: 'after' },
          ],
        }),
      ).rejects.toThrow('apply_line_edits: cannot read file —');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes the turn AbortSignal to writeFileAtomic', async () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.forge-line-edit-signal-'));
    const filePath = path.join(directory, 'sample.ts');
    fs.writeFileSync(filePath, 'before\n', 'utf8');
    const controller = new AbortController();
    const write = vi.spyOn(atomicWrite, 'writeFileAtomic').mockResolvedValue();
    try {
      await makeApplyLineEditsTool().handler(
        {
          path: filePath,
          operations: [
            { start_line: 1, end_line: 1, expected_text: 'before', replacement_text: 'after' },
          ],
        },
        { beforeMutate: () => undefined, abortSignal: controller.signal },
      );
      expect(write).toHaveBeenCalledWith(
        filePath,
        'after\n',
        expect.objectContaining({
          signal: controller.signal,
          expected: expect.any(Object),
          retryBudgetMs: atomicWrite.ASYNC_RENAME_BUDGET_MS,
        }),
      );
    } finally {
      write.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('applies ordered edits atomically from the bottom and preserves CRLF', () => {
    const result = applyLineEditsToContent('one\r\ntwo\r\nthree\r\nfour\r\n', [
      {
        start_line: 1,
        end_line: 1,
        expected_text: 'one',
        replacement_text: 'ONE',
      },
      {
        start_line: 3,
        end_line: 4,
        expected_text: 'three\nfour',
        replacement_text: 'THREE',
      },
    ]);
    expect(result).toEqual({
      content: 'ONE\r\ntwo\r\nTHREE\r\n',
      replacedLines: 3,
      replacementLines: 2,
      autoAligned: [],
    });
  });

  it('rejects stale expected content before producing an edit', () => {
    expect(() =>
      applyLineEditsToContent('current\n', [
        {
          start_line: 1,
          end_line: 1,
          expected_text: 'old',
          replacement_text: 'new',
        },
      ]),
    ).toThrow('is stale');
  });

  it('reports the original one-based index when the third operation is stale', () => {
    expect(() =>
      applyLineEditsToContent('a\nb\nc\nd\ne\nf', [
        { start_line: 1, end_line: 1, expected_text: 'a', replacement_text: 'A' },
        { start_line: 3, end_line: 3, expected_text: 'c', replacement_text: 'C' },
        { start_line: 5, end_line: 5, expected_text: 'wrong', replacement_text: 'E' },
      ]),
    ).toThrow('apply_line_edits: operation 3 is stale');
  });

  it('sorts out-of-order operations and names overlapping operation ranges', () => {
    expect(
      applyLineEditsToContent('a\nb\nc', [
        { start_line: 3, end_line: 3, expected_text: 'c', replacement_text: 'C' },
        { start_line: 1, end_line: 1, expected_text: 'a', replacement_text: 'A' },
      ]).content,
    ).toBe('A\nb\nC');
    expect(() =>
      applyLineEditsToContent('a\nb\nc', [
        { start_line: 2, end_line: 2, expected_text: 'b', replacement_text: 'B' },
        { start_line: 2, end_line: 3, expected_text: 'b\nc', replacement_text: 'C' },
      ]),
    ).toThrow('operation 1 lines 2-2 overlaps operation 2 lines 2-3');
    expect(() =>
      applyLineEditsToContent('a\n', [
        { start_line: 2, end_line: 2, expected_text: '\n', replacement_text: 'b' },
      ]),
    ).toThrow('out-of-range');
  });

  it('corrects a miscounted end_line whose text matches at start_line, and refuses one that does not', () => {
    // Prevention pass (2026-11-09): a miscount whose text matches at the named start is not a
    // disagreement — the tool fixes its own argument. A miscount whose text does NOT match there
    // still refuses, because which copy was meant is the caller's call.
    const result = applyLineEditsToContent('a\nb\nc\nd\n', [
      { start_line: 2, end_line: 4, expected_text: 'b\nc', replacement_text: 'B' },
    ]);
    expect(result.content).toBe('a\nB\nd\n');
    expect(result.replacedLines).toBe(2);
    expect(result.autoAligned).toEqual([{ index: 1, startLine: 2, statedEnd: 4, actualEnd: 3 }]);
    expect(() =>
      applyLineEditsToContent('a\nb\nc\nd\n', [
        { start_line: 1, end_line: 3, expected_text: 'b\nc', replacement_text: 'B' },
      ]),
    ).toThrow('expected_text has 2 line(s), but lines 1-3 are 3 line(s)');
  });

  it('an empty expected_text keeps the true count refusal, not a phantom alignment', () => {
    // Claude review defect 2: `[]` matches every slice, so the aligner must not treat an empty
    // block as a miscount — the count refusal is the honest answer.
    let message = '';
    try {
      applyLineEditsToContent('a\nb\nc\n', [
        { start_line: 1, end_line: 3, expected_text: '', replacement_text: 'x' },
      ]);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toBe(
      'apply_line_edits: operation 1 expected_text has 0 line(s), but lines 1-3 are 3 line(s). ' +
        'expected_text must be exactly the current text of start_line through end_line, one line '
      +
        'per newline. Current file lines 1-3:\n1|a\n2|b\n3|c',
    );
  });

  it('derives one omitted bound from expected_text when dispatching the tool', async () => {
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
            { start_line: 2, expected_text: 'two', replacement_text: 'TWO' },
          ],
        }),
      ).resolves.toContain('"operationsApplied":1');
      await expect(
        tool.handler({
          path: relativePath,
          operations: [
            { end_line: 3, expected_text: 'three', replacement_text: 'THREE' },
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
        { start_line: 1, end_line: 1, expected_text: 'same', replacement_text: 'same' },
      ]),
    ).toThrow('would not change');
  });

  it('rejects mixed line endings instead of normalizing unrelated lines', () => {
    expect(() =>
      applyLineEditsToContent('one\r\ntwo\n', [
        { start_line: 1, end_line: 1, expected_text: 'one', replacement_text: 'ONE' },
      ]),
    ).toThrow('mixed or bare-CR');
  });

  it('enforces operation-count and cumulative replacement budgets', () => {
    const repeated = Array.from({ length: 21 }, (_, index) => ({
      start_line: index + 1,
      end_line: index + 1,
      expected_text: 'a',
      replacement_text: 'b',
    }));
    expect(() => applyLineEditsToContent(Array(21).fill('a').join('\n'), repeated)).toThrow(
      '1-20 entries',
    );

    expect(() =>
      applyLineEditsToContent(Array(17).fill('a').join('\n'), [
        {
          start_line: 1,
          end_line: 17,
          expected_text: Array(17).fill('a').join('\n'),
          replacement_text: Array(17).fill('x'.repeat(4_000)).join('\n'),
        },
      ]),
    ).toThrow('replacement_text exceeds 64000 characters');
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

  it('declares each side as one text field, not an array of lines', () => {
    const items = (
      makeApplyLineEditsTool().definition.function.parameters as {
        properties: {
          operations: {
            items: { properties: Record<string, unknown>; required: string[] };
          };
        };
      }
    ).properties.operations.items;
    expect(items.properties['expected_text']).toEqual({ type: 'string', minLength: 1 });
    expect(items.properties['replacement_text']).toEqual({ type: 'string' });
    expect(items.properties['expected_lines']).toBeUndefined();
    expect(items.properties['replacement_lines']).toBeUndefined();
    expect(items.required).toEqual(['expected_text', 'replacement_text']);
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
              expected_text: 'const value = 1;',
              replacement_text: 'const value = 2;',
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
              expected_text: 'const value = 1;',
              replacement_text: 'const value = 3;',
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
                expected_text: 'one',
                replacement_text: 'ONE',
              },
              {
                path: relative,
                start_line: 3,
                end_line: 3,
                expected_text: 'three',
                replacement_text: 'THREE',
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
                expected_text: 'one',
                replacement_text: 'ONE',
              },
              {
                start_line: 2,
                end_line: 2,
                expected_text: 'two',
                replacement_text: 'TWO',
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
                expected_text: 'one',
                replacement_text: 'ONE',
              },
              {
                path: other,
                start_line: 2,
                end_line: 2,
                expected_text: 'two',
                replacement_text: 'TWO',
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

  it('refuses an operation naming a different file than the top-level path, by name', async () => {
    // The top-level `path` used to win silently: the operation naming another
    // file was applied to the file above it, and nothing said so.
    const refusal = await makeApplyLineEditsTool()
      .handler({
        path: 'src/a.ts',
        operations: [
          {
            path: 'src/b.ts',
            start_line: 1,
            end_line: 1,
            expected_text: 'x',
            replacement_text: 'y',
          },
        ],
      })
      .then(
        () => '',
        (error: Error) => error.message,
      );

    expect(refusal).toBe(
      'apply_line_edits: operation path "src/b.ts" differs from the call\'s path "src/a.ts"; ' +
        'one call edits one file. Send a separate call for "src/b.ts".',
    );
  });

  it('allows an operation that repeats the top-level path in another spelling', async () => {
    const { tool, relative, file, cleanup } = fixture();
    try {
      const result = String(
        await tool.handler(
          {
            path: `.${path.sep}${relative}`,
            operations: [
              {
                path: relative,
                start_line: 1,
                end_line: 1,
                expected_text: 'one',
                replacement_text: 'ONE',
              },
              {
                start_line: 3,
                end_line: 3,
                expected_text: 'three',
                replacement_text: 'THREE',
              },
            ],
          },
          context,
        ),
      );
      expect(result).toContain('"operationsApplied":2');
      expect(fs.readFileSync(file, 'utf8')).toBe('ONE\ntwo\nTHREE\n');
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

  it('refuses operations sent as a JSON string and leaves the file unchanged', async () => {
    const { tool, relative, file, cleanup } = fixture();
    try {
      const message = new ToolRegistry().invalidArgs(tool, {
        operations: JSON.stringify([{ path: relative, start_line: 1 }]),
      });
      expect(message).toBe(
        'Error: apply_line_edits: "operations" must be a JSON array, not a string. ' +
          'Resend the call with operations as [].',
      );
      expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');
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
              { start_line: 1, end_line: 1, expected_text: 'one', replacement_text: 'ONE' },
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

/**
 * 2026-11-24: each side of an operation became one string. The array form — every code line a
 * separately quoted item, two list levels deep — arrived unparseable in 23 of 474 calls, against
 * 40 of 10,942 for `edit_file`, which takes one string per side. These rows pin the split rule the
 * plan specifies and the things the string shape must still do: delete a range, refuse the old
 * names, and survive the characters that broke the array shape.
 */
describe('apply_line_edits text fields', () => {
  it('splits one side into lines by the one rule, for both fields', () => {
    expect(splitEditTextLines('')).toEqual([]);
    expect(splitEditTextLines('\n')).toEqual(['']);
    expect(splitEditTextLines('a')).toEqual(['a']);
    expect(splitEditTextLines('a\n')).toEqual(['a']);
    expect(splitEditTextLines('a\n\n')).toEqual(['a', '']);
    expect(splitEditTextLines('a\r\nb')).toEqual(['a', 'b']);
  });

  it('applies that rule to both sides of a real edit', () => {
    // `"a\n\n"` is two lines (`a`, blank) and `""` is none, so the range 1-2 goes from `a`+
    // blank to blank: the trailing newline of expected_text is a line break, not padding.
    const result = applyLineEditsToContent('a\n\nc\n', [
      { start_line: 1, end_line: 2, expected_text: 'a\n\n', replacement_text: '\n' },
    ]);
    expect(result.content).toBe('\nc\n');
    expect(result.replacementLines).toBe(1);
  });

  it('deletes the range when replacement_text is empty', () => {
    expect(
      applyLineEditsToContent('a\nb\nc\n', [
        { start_line: 2, end_line: 3, expected_text: 'b\nc', replacement_text: '' },
      ]).content,
    ).toBe('a\n');
  });

  it('refuses more split lines than one operation may carry', () => {
    const text = Array(501).fill('a').join('\n');
    expect(() =>
      applyLineEditsToContent(text, [
        { start_line: 1, end_line: 501, expected_text: text, replacement_text: 'x' },
      ]),
    ).toThrow('apply_line_edits: operation 1 has invalid expected_text');
  });

  it('refuses a side that is not a string, and says what to send', async () => {
    let message = '';
    try {
      await makeApplyLineEditsTool().handler({
        path: 'sample.ts',
        operations: [
          { start_line: 1, end_line: 1, expected_text: ['one'], replacement_text: 'ONE' },
        ],
      });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toBe(
      'apply_line_edits: operation 1 has invalid expected_text: send one string, the lines ' +
        'joined with newlines',
    );
  });

  it('refuses the old array field names, naming the new field in both shapes', async () => {
    const tool = makeApplyLineEditsTool();
    const both = { start_line: 1, end_line: 1, expected_lines: ['one'], replacement_lines: ['ONE'] };
    const one = { start_line: 1, end_line: 1, expected_lines: ['one'], replacement_text: 'ONE' };
    let bothMessage = '';
    let oneMessage = '';
    try {
      await tool.handler({ path: 'sample.ts', operations: [both] });
    } catch (error) {
      bothMessage = String((error as Error).message);
    }
    try {
      await tool.handler({ path: 'sample.ts', operations: [one] });
    } catch (error) {
      oneMessage = String((error as Error).message);
    }
    expect(bothMessage).toBe(
      'apply_line_edits: operation 1 sends "expected_lines" and "replacement_lines"; ' +
        'expected_lines is now expected_text: one string, the lines joined with newlines; ' +
        'replacement_lines is now replacement_text: one string, the lines joined with newlines. ' +
        'Nothing ran. Resend the operation with the new field names.',
    );
    expect(oneMessage).toBe(
      'apply_line_edits: operation 1 sends "expected_lines"; ' +
        'expected_lines is now expected_text: one string, the lines joined with newlines. ' +
        'Nothing ran. Resend the operation with the new field names.',
    );
  });

  it('lands a replacement_text holding quotes and a closing bracket, byte for byte', async () => {
    // The characters that broke the array shape: a `"` inside a quoted line and a `]` that is
    // indistinguishable from the array's own closer. As one string they need no special handling.
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.forge-line-edit-chars-'));
    const filePath = path.join(directory, 'sample.ts');
    fs.writeFileSync(filePath, 'const parts = [\n  "a",\n];\n', 'utf8');
    try {
      await expect(
        makeApplyLineEditsTool().handler({
          path: filePath,
          operations: [
            {
              start_line: 1,
              end_line: 3,
              expected_text: 'const parts = [\n  "a",\n];',
              replacement_text: 'const parts = [\n  "a",\n  "b]",\n];',
            },
          ],
        }),
      ).resolves.toContain('"operationsApplied":1');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'const parts = [\n  "a",\n  "b]",\n];\n',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
