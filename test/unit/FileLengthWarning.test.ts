import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countLinesAsWcL,
  fileLengthWarning,
  withFileLengthWarning,
  type FileLengthWarningSettings,
} from '../../src/tools/fileLengthWarning';
import { makeWriteFileTool } from '../../src/tools/builtinTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { ForgeConfigSchema } from '../../src/config/schema';

/**
 * `tools.file_length_warning` (docs/plans/V1_FINISH_PLAN.md lane 5, phase 5.1).
 *
 * The point is not the text, it is WHERE the text comes from: one shared point
 * for every tool that writes a file's contents, so the four tools cannot drift
 * apart and so an agent hears the limit at the moment it crosses it rather than
 * when ESLint fails at the end of its turn (lane 1 took `ToolDispatch.ts`
 * 488 → 528 lines this way).
 */

const SETTINGS: FileLengthWarningSettings = {
  warn_at: 450,
  max: 500,
  globs: ['**/*.ts'],
};

const WARN_LINE =
  'This file is now 451 lines (limit 500, from tools.file_length_warning). ' +
  'Plan where to split it before adding more.';
const OVER_LINE =
  'This file is now 501 lines, over the limit 500 (from tools.file_length_warning); ' +
  'split it at a real seam before continuing.';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-length-'));
  vscode.workspace.workspaceFolders.splice(0, Infinity, {
    uri: vscode.Uri.file(root),
    name: 'length-fixture',
  });
});

afterEach(() => {
  vscode.workspace.workspaceFolders.splice(0);
  fs.rmSync(root, { recursive: true, force: true });
});

/** `n` lines, each terminated, as this repo's files are (LF endings). */
function lines(n: number, from = 1): string {
  return Array.from({ length: n }, (_, index) => `line ${from + index}`).join('\n') + '\n';
}

/** The tool-layer settings, as `registerAllTools` reads them from config.yaml. */
const settingsFor =
  (settings: FileLengthWarningSettings | undefined) => (): FileLengthWarningSettings | undefined =>
    settings;

const context = { beforeMutate: () => undefined };

describe('countLinesAsWcL', () => {
  it('counts the lines of a newline-terminated file exactly as wc -l does', () => {
    const file = path.join(root, 'probe.txt');
    fs.writeFileSync(file, lines(7), 'utf8');

    expect(countLinesAsWcL(fs.readFileSync(file, 'utf8'))).toBe(7);
    if (process.platform === 'win32') return;
    // The definition being tested, run against the program it is named after:
    // `wc -l` counts line breaks, so this is the check that pins the semantics.
    const wc = spawnSync('wc', ['-l', file], { encoding: 'utf8' });
    expect(wc.status).toBe(0);
    expect(Number(wc.stdout.trim().split(/\s+/u)[0])).toBe(countLinesAsWcL(lines(7)));
  });

  it('reports one fewer for a last line with no line break, as wc -l does', () => {
    expect(countLinesAsWcL('a\nb\nc')).toBe(2);
    expect(countLinesAsWcL('a\nb\nc\n')).toBe(3);
    expect(countLinesAsWcL('')).toBe(0);
    expect(countLinesAsWcL('\n')).toBe(1);
  });

  it('counts a CRLF file by its line breaks too', () => {
    expect(countLinesAsWcL('a\r\nb\r\nc\r\n')).toBe(3);
  });
});

describe('fileLengthWarning', () => {
  it('says nothing when the config block is absent', () => {
    const file = path.join(root, 'big.ts');
    fs.writeFileSync(file, lines(900), 'utf8');
    expect(fileLengthWarning(file, undefined)).toBe('');
    expect(withFileLengthWarning('Written x', file, undefined)).toBe('Written x');
  });

  it('says nothing when an empty glob list is configured', () => {
    const file = path.join(root, 'big.ts');
    fs.writeFileSync(file, lines(900), 'utf8');
    expect(fileLengthWarning(file, { ...SETTINGS, globs: [] })).toBe('');
  });

  it('says nothing for a file the globs do not name', () => {
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, lines(900), 'utf8');
    expect(fileLengthWarning(file, SETTINGS)).toBe('');
  });

  it('matches a workspace-relative glob, not only an absolute path', () => {
    const file = path.join(root, 'src', 'tools', 'x.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines(460), 'utf8');
    expect(fileLengthWarning(file, { warn_at: 450, max: 500, globs: ['src/**/*.ts'] })).toContain(
      '460 lines',
    );
  });

  it('warns for every file when no globs are configured', () => {
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, lines(460), 'utf8');
    expect(fileLengthWarning(file, { warn_at: 450, max: 500 })).toContain('460 lines');
  });

  it('names the count, the limit and where the limit came from', () => {
    const file = path.join(root, 'tool.ts');
    fs.writeFileSync(file, lines(451), 'utf8');
    expect(fileLengthWarning(file, SETTINGS)).toBe(WARN_LINE);
  });

  it('uses the stronger line above max, and the plain line at max', () => {
    const over = path.join(root, 'over.ts');
    const at = path.join(root, 'at.ts');
    fs.writeFileSync(over, lines(501), 'utf8');
    fs.writeFileSync(at, lines(500), 'utf8');
    expect(fileLengthWarning(over, SETTINGS)).toBe(OVER_LINE);
    expect(fileLengthWarning(at, SETTINGS)).toContain('This file is now 500 lines (limit 500');
  });

  it('says nothing when the file is still below warn_at, and says it when it stayed above', () => {
    const below = path.join(root, 'below.ts');
    const above = path.join(root, 'above.ts');
    fs.writeFileSync(below, lines(449), 'utf8');
    fs.writeFileSync(above, lines(600), 'utf8');
    expect(fileLengthWarning(below, SETTINGS)).toBe('');
    // A write that shrinks a long file but leaves it over the threshold is still
    // a file the agent should be planning to split.
    expect(fileLengthWarning(above, SETTINGS)).toContain('600 lines');
  });

  it('advises only: a file it cannot read gets no line, not a failure', () => {
    expect(fileLengthWarning(path.join(root, 'gone.ts'), SETTINGS)).toBe('');
    expect(withFileLengthWarning('Replaced in gone.ts', path.join(root, 'gone.ts'), SETTINGS)).toBe(
      'Replaced in gone.ts',
    );
  });
});

describe('the write tools all report the line from the same point', () => {
  it('write_file adds the line when the write reaches warn_at', async () => {
    const result = String(
      await makeWriteFileTool(() => [], settingsFor(SETTINGS)).handler(
        { path: 'ui.ts', content: lines(451) },
        context,
      ),
    );
    expect(result).toContain(WARN_LINE);
  });

  it('write_file adds the over-the-limit line above max', async () => {
    const result = String(
      await makeWriteFileTool(() => [], settingsFor(SETTINGS)).handler(
        { path: 'ui.ts', content: lines(501) },
        context,
      ),
    );
    expect(result).toContain(OVER_LINE);
  });

  it('mode "append" measures the whole file, not the chunk', async () => {
    const write = makeWriteFileTool(() => [], settingsFor(SETTINGS));
    await write.handler({ path: 'ui.ts', content: lines(300) }, context);
    const result = await write.handler(
      { path: 'ui.ts', content: lines(151, 301), mode: 'append' },
      context,
    );
    expect(String(result)).toContain(WARN_LINE);
  });

  it('edit_file adds the line for a full and a partly-applied call', async () => {
    const tool = makeEditFileTool(() => [], settingsFor(SETTINGS));
    fs.writeFileSync(path.join(root, 'ui.ts'), lines(449), 'utf8');
    const result = String(
      await tool.handler(
        {
          path: 'ui.ts',
          edits: [
            { old_str: 'line 1\nline 2', new_str: 'line 1\nline 2\nadded a\nadded b' },
            { old_str: 'not in the file', new_str: 'whatever' },
          ],
        },
        context,
      ),
    );
    expect(result).toContain('Partly applied');
    expect(result).toContain(WARN_LINE);
  });

  it('apply_line_edits adds the line after its JSON result', async () => {
    const tool = makeApplyLineEditsTool(() => [], settingsFor(SETTINGS));
    fs.writeFileSync(path.join(root, 'ui.ts'), lines(449), 'utf8');
    const result = String(
      await tool.handler(
        {
          path: 'ui.ts',
          operations: [
            {
              start_line: 1,
              end_line: 2,
              expected_text: 'line 1\nline 2',
              replacement_text: 'line 1\nline 2\nadded a\nadded b',
            },
          ],
        },
        context,
      ),
    );
    expect(result).toContain('"operationsApplied":1');
    expect(result).toContain(WARN_LINE);
  });

  it('the four tools say the identical line, because one function says it', async () => {
    const said = await Promise.all([
      makeWriteFileTool(() => [], settingsFor(SETTINGS)).handler(
        { path: 'a.ts', content: lines(451) },
        context,
      ),
      makeWriteFileTool(() => [], settingsFor(SETTINGS))
        .handler({ path: 'b.ts', content: lines(300) }, context)
        .then(() =>
          makeWriteFileTool(() => [], settingsFor(SETTINGS)).handler(
            { path: 'b.ts', content: lines(151, 301), mode: 'append' },
            context,
          ),
        ),
      (async () => {
        fs.writeFileSync(path.join(root, 'c.ts'), lines(449), 'utf8');
        return makeEditFileTool(() => [], settingsFor(SETTINGS)).handler(
          {
            path: 'c.ts',
            old_str: 'line 1',
            new_str: 'line 1\nextra a\nextra b',
          },
          context,
        );
      })(),
      (async () => {
        fs.writeFileSync(path.join(root, 'd.ts'), lines(449), 'utf8');
        return makeApplyLineEditsTool(() => [], settingsFor(SETTINGS)).handler(
          {
            path: 'd.ts',
            operations: [
              {
                start_line: 1,
                end_line: 2,
                expected_text: 'line 1\nline 2',
                replacement_text: 'line 1\nline 2\nextra a\nextra b',
              },
            ],
          },
          context,
        );
      })(),
    ]);
    const linesOf = said.map((result) => String(result).split('\n').at(-1));
    expect(new Set(linesOf).size).toBe(1);
    expect(linesOf[0]).toBe(WARN_LINE);
  });

  it('nothing changes when the config block is absent', async () => {
    const write = makeWriteFileTool(() => []);
    const edit = makeEditFileTool(() => []);
    const lineEdits = makeApplyLineEditsTool(() => []);
    fs.writeFileSync(path.join(root, 'ui.ts'), lines(449), 'utf8');
    fs.writeFileSync(path.join(root, 'ed.ts'), lines(449), 'utf8');
    // Its own fixture file: `edit_file` above has already shifted this one's
    // line numbers, and `apply_line_edits` refuses on that rather than guessing.
    fs.writeFileSync(path.join(root, 'le.ts'), lines(449), 'utf8');

    const written = String(await write.handler({ path: 'ui.ts', content: lines(900) }, context));
    const appended = String(
      await write.handler({ path: 'ui.ts', content: 'tail\n', mode: 'append' }, context),
    );
    const replaced = String(
      await edit.handler(
        { path: 'ed.ts', old_str: 'line 1\nline 2', new_str: 'line 1\nextra' },
        context,
      ),
    );
    const structured = String(
      await lineEdits.handler(
        {
          path: 'le.ts',
          operations: [
            {
              start_line: 1,
              end_line: 2,
              expected_text: 'line 1\nline 2',
              replacement_text: 'line 1\nline 2\nextra',
            },
          ],
        },
        context,
      ),
    );
    // The path is the real one, so it is matched by prefix rather than compared
    // to a spelling: a Windows temp folder can come back through realpath with
    // its 8.3 short name, and that is not what this test is about. The anchor is
    // two whole lines because `line 1` alone also occurs inside `line 10` and
    // `line 100`, and `edit_file` now says how many copies of old_str it left
    // behind — a sentence this test must not swallow into its exact comparison.
    expect(written).toMatch(/^Written /);
    expect(appended).toContain('bytes total');
    expect(replaced).toBe('Replaced in ed.ts');
    expect(structured).toContain('"operationsApplied":1');
    expect(`${written}\n${appended}\n${replaced}\n${structured}`).not.toContain(
      'tools.file_length_warning',
    );
  });

  it('a write that stays below warn_at adds nothing', async () => {
    const result = String(
      await makeWriteFileTool(() => [], settingsFor(SETTINGS)).handler(
        { path: 'ui.ts', content: lines(449) },
        context,
      ),
    );
    expect(result).toMatch(/^Written /);
    expect(result).not.toContain('tools.file_length_warning');
  });
});

describe('tools.file_length_warning config schema', () => {
  const base = () => ({
    active_model: 'm',
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
  });
  const parse = (tools: unknown) =>
    ForgeConfigSchema.safeParse({ ...base(), tools } as Record<string, unknown>);

  it('accepts the block Claude adds after install, and defaults to absent', () => {
    const parsed = parse({
      file_length_warning: { warn_at: 450, max: 500, globs: ['**/*.ts', '**/*.tsx'] },
    });
    expect(parsed.success).toBe(true);
    const absent = ForgeConfigSchema.safeParse(base());
    expect(absent.success).toBe(true);
    expect(absent.success && absent.data.tools).toBeUndefined();
  });

  it('refuses warn_at at or above max, naming the field', () => {
    for (const bad of [
      { warn_at: 500, max: 500 },
      { warn_at: 501, max: 500 },
      { warn_at: 0, max: 500 },
      { warn_at: 450.5, max: 500 },
    ]) {
      const result = parse({ file_length_warning: bad });
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(['tools', 'file_length_warning', 'warn_at']);
      }
    }
    expect(parse({ file_length_warning: { warn_at: 350, max: 500 } }).success).toBe(true);
  });

  it('refuses a glob list that is not a list of patterns', () => {
    expect(parse({ file_length_warning: { warn_at: 450, max: 500, globs: [''] } }).success).toBe(
      false,
    );
    expect(
      parse({ file_length_warning: { warn_at: 450, max: 500, globs: '**/*.ts' } }).success,
    ).toBe(false);
  });
});
