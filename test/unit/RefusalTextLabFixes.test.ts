import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { applyLineEditsToContent } from '../../src/tools/structuredEditTool';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { makeReadFileTool } from '../../src/tools/readFileTool';
import { makeAskUserTool } from '../../src/tools/askUserTool';
import type { RegisteredTool } from '../../src/tools/ToolRegistry';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
}));

/**
 * These tests pin the refusal texts the overnight lab (docs/reports/TOOL_TEST_LEDGER.md, T16/T27/
 * T32/T35/T36) asked for. Each one exists because a measured failure class cost the model a turn it
 * could have avoided: the refusal is what teaches, so the refusal has to contain the answer.
 */
describe('lab-measured refusal texts', () => {
  const file = ['alpha', 'beta', 'gamma', 'delta'].join('\n') + '\n';

  it('stale refusal points at the lines the model actually described, when they still exist', () => {
    // The file moved: a line was inserted above the target, so the model's range now holds
    // different text while its own lines are still in the file, one line lower.
    const moved = ['head', ...file.split('\n').filter((line) => line !== '')].join('\n') + '\n';
    expect(() =>
      applyLineEditsToContent(moved, [
        {
          start_line: 2,
          end_line: 3,
          expected_text: 'beta\ngamma',
          replacement_text: 'BETA\ngamma',
        },
      ]),
    ).toThrow(/but it DOES match lines 3-4 — use those line numbers/);
  });

  it('stale refusal echoes the current range and says the file may have moved', () => {
    expect(() =>
      applyLineEditsToContent(file, [
        {
          start_line: 2,
          end_line: 3,
          expected_text: 'beta\nmissing',
          replacement_text: 'BETA',
        },
      ]),
    ).toThrow(/Current file lines 2-3:\n2\|beta\n3\|gamma[\s\S]*the file changed since you read it/);
  });

  it('a common line that appears more than once is never named as "the" place', () => {
    // Claude review item 1: `}` on lines 3 and 9, operation asks for line 6. Naming one copy
    // "use those line numbers" is the wrong-lines trap the moved-file guard exists to stop.
    const lines = ['a', '', '}', 'x', 'y', 'z', 'w', '', '}', 'b'];
    let message = '';
    try {
      applyLineEditsToContent(lines.join('\n') + '\n', [
        {
          start_line: 6,
          end_line: 6,
          expected_text: '}',
          replacement_text: '}',
        },
      ]);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toBe(
      'apply_line_edits: operation 1 is stale; expected_text does not match the current file, and ' +
        'it appears 2 times in it (lines 3-3, 9-9, nearest to your requested range first), so no ' +
        'single range is safe to name. No changes were written. Current file lines 6-6:\n' +
        '6|z\n' +
        'If these are not the lines you meant, the file changed since you read it — re-read it ' +
        'before editing.',
    );
  });

  it('a miscounted end_line whose text matches at start_line is corrected, not refused', async () => {
    // The owner's prevention pass (2026-11-09 10:47): the teacher's own live session hit this
    // shape twice — the model's text was right, its end number was wrong, and the refusal cost
    // a round to learn nothing new. The tool now fixes its own argument and says so.
    const target = path.join(process.cwd(), `align-${process.pid}.txt`);
    fs.writeFileSync(target, file, 'utf8');
    try {
      const out = String(
        await makeApplyLineEditsTool().handler({
          path: target,
          operations: [
            {
              start_line: 2,
              end_line: 2,
              expected_text: 'beta\ngamma',
              replacement_text: 'BETA\nGAMMA',
            },
          ],
        }),
      );
      expect(out.slice(out.indexOf('\nNote: operation'))).toBe(
        '\nNote: operation 1 end_line 2 did not match its expected_text line count; applied at lines ' +
          '2-3 because the text matched exactly at start_line.',
      );
      expect(fs.readFileSync(target, 'utf8')).toContain('BETA\nGAMMA');
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it('auto-align does NOT fire when the text matches only somewhere else', () => {
    // Miscount + wrong content at the named start = a disagreement, refused either way: with
    // the count-mismatch echo when the span length differs, with the "DO match lines" refusal
    // when the span length happens to equal the count. Only a miscount whose text matches AT
    // the start is auto-corrected.
    const lines = ['x', 'x', 'beta', 'gamma', 'x'];
    let countMismatch = '';
    try {
      applyLineEditsToContent(lines.join('\n') + '\n', [
        {
          start_line: 1,
          end_line: 1,
          expected_text: 'beta\ngamma',
          replacement_text: 'BETA',
        },
      ]);
    } catch (error) {
      countMismatch = String((error as Error).message);
    }
    expect(countMismatch).toBe(
      'apply_line_edits: operation 1 expected_text has 2 line(s), but lines 1-1 are 1 line(s). ' +
        'expected_text must be exactly the current text of start_line through end_line, one line ' +
        'per newline. Current file lines 1-1:\n1|x',
    );
    // Same block, span length matching the count: the stale refusal names the real lines.
    expect(() =>
      applyLineEditsToContent(lines.join('\n') + '\n', [
        {
          start_line: 1,
          end_line: 2,
          expected_text: 'beta\ngamma',
          replacement_text: 'BETA',
        },
      ]),
    ).toThrow(/but it DOES match lines 3-4 — use those line numbers/);
  });

  it('five copies with long lines still fits the cap and keeps the warning last', () => {
    // Claude review on f6a977a9: more than three copies writes "closest 3:", the cap counts the
    // whole message, and the re-read warning must survive the cut as the last words. The copies
    // are single lines (`}`), so the counted block matches five times.
    const long = 'q'.repeat(100);
    const lines = Array.from({ length: 20 }, (_, i) =>
      [2, 5, 8, 12, 17].includes(i + 1) ? '}' : long,
    );
    let message = '';
    try {
      applyLineEditsToContent(lines.join('\n') + '\n', [
        {
          start_line: 1,
          end_line: 1,
          expected_text: '}',
          replacement_text: 'x',
        },
      ]);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain('closest 3: lines ');
    expect(message.length).toBeLessThanOrEqual(1200);
    expect(message.endsWith('re-read it before editing.')).toBe(true);
  });

  it('the whole stale message stays inside the 1,200-char cap and keeps its warning', () => {
    // Claude review item 2: the old code capped only the quoted block, so prefix + 1200 + suffix
    // could reach ~1,450 characters, and the heading printed twice.
    const longLine = 'z'.repeat(300);
    const lines = Array.from({ length: 12 }, () => longLine);
    let message = '';
    try {
      applyLineEditsToContent(lines.join('\n') + '\n', [
        {
          start_line: 1,
          end_line: 12,
          expected_text: lines.map(() => 'zzz not these lines zzz').join('\n'),
          replacement_text: 'x',
        },
      ]);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message.length).toBeLessThanOrEqual(1200);
    expect(message).toMatch(/re-read it before editing/);
    expect(message.match(/Current file lines 1-12:/g)).toHaveLength(1);
  });

  it('out-of-range span names the file length and the widest span that would work', () => {
    expect(() =>
      applyLineEditsToContent(file, [
        {
          start_line: 2,
          end_line: 8,
          expected_text: 'beta\ngamma\ndelta\ne\nf\ng\nh',
          replacement_text: 'BETA',
        },
      ]),
    ).toThrow(/out-of-range line span; the file has 4 line\(s\), so a span must lie within 1-4/);
  });

  it('read_file past the end answers with the length note instead of an error', async () => {
    const target = path.join(process.cwd(), `read-range-${process.pid}.txt`);
    fs.writeFileSync(target, file, 'utf8');
    try {
      await expect(
        makeReadFileTool().handler({ path: target, start_line: 13, end_line: 20 }),
      ).resolves.toBe(
        'read_file: the file has 4 line(s), so there is nothing to read at lines 13-20. You have '
          + 'reached the end.',
      );
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it('edit_file says the file may have changed since it was read', async () => {
    const target = path.join(process.cwd(), `edit-miss-${process.pid}.txt`);
    fs.writeFileSync(target, file, 'utf8');
    try {
      await expect(
        makeEditFileTool().handler({ path: target, old_str: 'beta\nMISSING', new_str: 'BETA' }),
      ).rejects.toThrow(/The file may have changed since you read it/);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it('quoted booleans are accepted case-insensitively for declared boolean arguments', () => {
    const registry = new ToolRegistry();
    const tool: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: 'coerce_probe',
          description: 'probe',
          parameters: {
            type: 'object',
            properties: { background: { type: 'boolean' }, label: { type: 'string' } },
          },
        },
      },
      permission: 'read',
      handler: async () => 'ok',
    };
    registry.register(tool);
    for (const [spelling, expected] of [
      ['true', true],
      ['True', true],
      ['TRUE', true],
      ['TRUE ', true],
      ['  false  ', false],
      ['false', false],
      ['False', false],
      ['FALSE', false],
    ] as const) {
      const args = { background: spelling };
      expect(registry.invalidArgs(tool, args)).toBeUndefined();
      expect(args.background).toBe(expected);
    }
    const stringArgs = { background: 'true', label: 'True' };
    expect(registry.invalidArgs(tool, stringArgs)).toBeUndefined();
    expect(stringArgs).toEqual({ background: true, label: 'True' });
    expect(registry.invalidArgs(tool, { background: 'yes' })).toBe(
      'Error: coerce_probe: "background" must be a JSON boolean, not a string. Resend the call with background as true or false.',
    );
  });

  it('ask_user names the option that has no label instead of a bare "Invalid input"', async () => {
    const tool = makeAskUserTool({ ask: async () => ({}) } as never);
    // Both shapes the model reaches for: options at the top level, and options inside a question.
    await expect(
      tool.handler(
        {
          prompt: 'Pick one',
          options: [{ description: 'no label here' }, 'Fast'],
        },
        { conversationId: 'test' } as never,
      ),
    ).rejects.toThrow(/options\[0\] is missing "label"/);
    await expect(
      tool.handler(
        {
          questions: [
            { prompt: 'Pick one', options: [{ description: 'no label here' }, 'Fast'] },
          ],
        },
        { conversationId: 'test' } as never,
      ),
    ).rejects.toThrow(/questions\[0\]\.options\[0\] is missing "label"/);
  });
});
