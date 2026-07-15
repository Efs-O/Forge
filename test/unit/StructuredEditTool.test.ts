import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyLineEditsToContent,
  makeApplyLineEditsTool,
} from '../../src/tools/structuredEditTool';

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

  it('rejects overlapping and out-of-range spans', () => {
    expect(() =>
      applyLineEditsToContent('a\nb\nc', [
        { start_line: 2, end_line: 2, expected_lines: ['b'], replacement_lines: ['B'] },
        { start_line: 2, end_line: 3, expected_lines: ['b', 'c'], replacement_lines: ['C'] },
      ]),
    ).toThrow('ordered and non-overlapping');
    expect(() =>
      applyLineEditsToContent('a\n', [
        { start_line: 2, end_line: 2, expected_lines: [''], replacement_lines: ['b'] },
      ]),
    ).toThrow('out-of-range');
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
    expect(schema.required).toEqual(['path', 'operations']);
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
