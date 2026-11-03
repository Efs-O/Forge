import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEditFileTool, MAX_EDITS_PER_CALL } from '../../src/tools/editFileTool';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
}));

const target = path.join(process.cwd(), 'test', `edit-cap-${process.pid}.txt`);

afterEach(() => fs.rmSync(target, { force: true }));

describe('edit_file batch cap', () => {
  it('accepts 200 edits and rejects 201', async () => {
    expect(MAX_EDITS_PER_CALL).toBe(200);
    const tool = makeEditFileTool();
    const definition = tool.definition.function;
    expect(JSON.stringify(definition)).toContain('Up to 200');
    expect(definition.parameters).toMatchObject({
      properties: { edits: { maxItems: 200 } },
    });
    const edits = Array.from({ length: 200 }, (_, index) => ({
      old_str: `old-${index}`,
      new_str: `new-${index}`,
    }));
    fs.writeFileSync(target, edits.map((edit) => edit.old_str).join('\n'));
    await tool.handler({ path: target, edits });
    expect(fs.readFileSync(target, 'utf8')).toContain('new-199');

    await expect(tool.handler({ path: target, edits: [...edits, edits[0]] })).rejects.toThrow(
      'at most 200 edits per call',
    );
  });
});

describe('edit_file partial apply and indent shift', () => {
  it('writes the other edits of a 4-edit batch when one misses', async () => {
    fs.writeFileSync(target, 'one\ntwo\nthree\nfour\n');
    const result = String(
      await makeEditFileTool().handler({
        path: target,
        edits: [
          { old_str: 'one', new_str: '1' },
          { old_str: 'TWO', new_str: '2' },
          { old_str: 'three', new_str: '3' },
          { old_str: 'four', new_str: '4' },
        ],
      }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('1\ntwo\n3\n4\n');
    expect(result).toMatch(/^Partly applied: edit\(s\) 1, 3, 4 of 4 .*Edit\(s\) 2 not found/su);
  });

  it('reports an edit that depends on a missed one as missed too', async () => {
    fs.writeFileSync(target, 'alpha\n');
    await expect(
      makeEditFileTool().handler({
        path: target,
        edits: [
          { old_str: 'ALPHA', new_str: 'beta' },
          { old_str: 'beta', new_str: 'gamma' },
        ],
      }),
    ).rejects.toThrow('(all 2 edits)');
    expect(fs.readFileSync(target, 'utf8')).toBe('alpha\n');
  });

  it('applies the 4-spaces-for-2 case and says the indentation was adjusted', async () => {
    fs.writeFileSync(target, 'function f() {\n  r.duckT = 0;\n}\n');
    const result = String(
      await makeEditFileTool().handler({
        path: target,
        old_str: '    r.duckT = 0;',
        new_str: '    r.duckT = 1;',
      }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('function f() {\n  r.duckT = 1;\n}\n');
    expect(result).toBe(`Replaced in ${target} (indentation adjusted by -2 at line 2)`);
  });
});

describe('edit_file line-join warning', () => {
  it('warns when a replacement drops the line break and joins two lines', async () => {
    fs.writeFileSync(target, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const result = String(
      await makeEditFileTool().handler({
        path: target,
        old_str: 'const a = 1;\n',
        new_str: 'const a = 10;',
      }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('const a = 10;const b = 2;\nconst c = 3;\n');
    expect(result).toContain('two lines are now one (line 1)');
  });

  it('warns for a dropped leading line break too, and names the edit in a batch', async () => {
    fs.writeFileSync(target, 'x\ny\nz\n');
    const result = String(
      await makeEditFileTool().handler({
        path: target,
        edits: [
          { old_str: 'x', new_str: 'X' },
          { old_str: '\nz', new_str: 'Z' },
        ],
      }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('X\nyZ\n');
    expect(result).toContain('(edit 2: line 2)');
  });

  it('stays quiet for whole-line deletions and line-preserving edits, CRLF included', async () => {
    fs.writeFileSync(target, 'one\r\ntwo\r\nthree\r\n');
    const tool = makeEditFileTool();
    const deleted = String(await tool.handler({ path: target, old_str: 'two\n', new_str: '' }));
    const kept = String(await tool.handler({ path: target, old_str: 'one\n', new_str: 'ONE\n' }));
    expect(fs.readFileSync(target, 'utf8')).toBe('ONE\r\nthree\r\n');
    expect(deleted).not.toContain('Warning');
    expect(kept).not.toContain('Warning');
  });
});

describe('edit_file replace_all', () => {
  const tool = makeEditFileTool();

  it('replaces every occurrence and says how many it replaced', async () => {
    fs.writeFileSync(target, 'alpha\nbeta\nalpha\nbeta\nalpha\n');
    const result = String(
      await tool.handler({ path: target, old_str: 'alpha', new_str: 'A', replace_all: true }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('A\nbeta\nA\nbeta\nA\n');
    expect(result).toBe(`Replaced 3 occurrences in ${target}`);
  });

  // The safety the default is for, and the thing the old result could not say:
  // two copies left in the file read as a finished edit, and the next round
  // builds its anchor from a file that no longer matches what the model thinks
  // it wrote. Refusing here would have broken every first-occurrence edit this
  // tool has ever served, so the answer is the sentence, not the refusal.
  it('replaces only the first by default and names the copies that remain', async () => {
    fs.writeFileSync(target, 'alpha\nbeta\nalpha\nbeta\nalpha\n');
    const result = String(await tool.handler({ path: target, old_str: 'alpha', new_str: 'A' }));
    expect(fs.readFileSync(target, 'utf8')).toBe('A\nbeta\nalpha\nbeta\nalpha\n');
    expect(result).toContain('Replaced in');
    expect(result).toContain(
      '2 more copies of old_str are still in the file (only the first of 3 was replaced)',
    );
    expect(result).toContain('Use replace_all: true');
  });

  it('says nothing extra when replace_all had only one occurrence to take', async () => {
    fs.writeFileSync(target, 'one\ntwo\n');
    const result = String(
      await tool.handler({ path: target, old_str: 'one', new_str: 'ONE', replace_all: true }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('ONE\ntwo\n');
    expect(result).toBe(`Replaced in ${target}`);
  });

  // replace_all belongs to the individual edit, not to the call: a batch that
  // renames one identifier everywhere and fixes one line once must not have one
  // flag decide both.
  it('applies replace_all per edit inside a batch', async () => {
    fs.writeFileSync(target, 'alpha\nalpha\nbeta\nbeta\n');
    const result = String(
      await tool.handler({
        path: target,
        edits: [
          { old_str: 'alpha', new_str: 'A', replace_all: true },
          { old_str: 'beta', new_str: 'B' },
        ],
      }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('A\nA\nB\nbeta\n');
    expect(result).toContain('Applied 2 edits');
    expect(result).toContain('edit 1: 2 occurrences replaced');
    expect(result).toContain(
      'edit 2: 1 copy of old_str left in the file (only the first of 2 replaced; use replace_all: true)',
    );
  });

  it('still refuses when replace_all finds nothing at all', async () => {
    fs.writeFileSync(target, 'alpha\n');
    await expect(
      tool.handler({ path: target, old_str: 'omega', new_str: 'X', replace_all: true }),
    ).rejects.toThrow('old_str not found in file');
    expect(fs.readFileSync(target, 'utf8')).toBe('alpha\n');
  });

  it('takes every copy of a CRLF file without changing any other line ending', async () => {
    fs.writeFileSync(target, 'alpha\r\nbeta\r\nalpha\r\nbeta\r\n');
    await tool.handler({ path: target, old_str: 'alpha', new_str: 'A', replace_all: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('A\r\nbeta\r\nA\r\nbeta\r\n');
  });

  // A replace_all that drops a line break joins a line at every seam, and each
  // one has to be named: the offsets of the later seams moved by the earlier
  // replacements, so a line number taken from the original text would have
  // pointed at the wrong line.
  it('names every seam a replace_all joined', async () => {
    fs.writeFileSync(target, 'x\ny\nx\ny\n');
    const result = String(
      await tool.handler({ path: target, old_str: 'x\n', new_str: 'X', replace_all: true }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('Xy\nXy\n');
    expect(result).toContain('two lines are now one (line 1; line 2)');
  });

  // 20,000 splices of a 2 MB string is 40 GB of copying, and every seam counted
  // its line from the start of the file again. One pass now does both, so the
  // whole edit costs one scan of the file whatever the match count is.
  it('replaces 20,000 copies of a 2 MB file in one pass, writing what the splices would have', async () => {
    const content = `alpha${'x'.repeat(94)}\n`.repeat(20_000);
    expect(content.length).toBe(2_000_000);
    fs.writeFileSync(target, content);
    const started = Date.now();
    const result = String(
      await tool.handler({ path: target, old_str: 'alpha', new_str: 'A', replace_all: true }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toContain('Replaced 20000 occurrences in');
    expect(fs.readFileSync(target, 'utf8')).toBe(content.split('alpha').join('A'));
  });

  it('stops a long replace_all when the call is cancelled, before anything is written', async () => {
    const content = 'alpha\n'.repeat(2_500);
    fs.writeFileSync(target, content);
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.handler(
        { path: target, old_str: 'alpha', new_str: 'A', replace_all: true },
        { abortSignal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled during a long replace_all, before anything was written/);
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
  });

  // The cancel check is for the long case only: a cancelled turn that already
  // did the work still gets its edit written, exactly as it has always.
  it('still writes a short replace_all under an already-cancelled signal', async () => {
    fs.writeFileSync(target, 'alpha\nalpha\n');
    const controller = new AbortController();
    controller.abort();
    const result = String(
      await tool.handler(
        { path: target, old_str: 'alpha', new_str: 'A', replace_all: true },
        { abortSignal: controller.signal },
      ),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('A\nA\n');
    expect(result).toContain('Replaced 2 occurrences');
  });

  it('numbers the seams a replace_all joined after earlier replacements moved the offsets', async () => {
    fs.writeFileSync(target, 'aa\nb\naa\nb\n');
    const result = String(
      await tool.handler({ path: target, old_str: 'aa\n', new_str: 'A', replace_all: true }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('Ab\nAb\n');
    expect(result).toContain('two lines are now one (line 1; line 2)');
  });

  it('numbers a seam on the last line, and stays quiet when the seam is the end of the file', async () => {
    fs.writeFileSync(target, 'a\nx\nb\n');
    const middle = String(await tool.handler({ path: target, old_str: 'x\n', new_str: 'X' }));
    expect(fs.readFileSync(target, 'utf8')).toBe('a\nXb\n');
    expect(middle).toContain('two lines are now one (line 2)');
    fs.writeFileSync(target, 'a\nb\nx\n');
    const last = String(await tool.handler({ path: target, old_str: 'x\n', new_str: 'X' }));
    expect(fs.readFileSync(target, 'utf8')).toBe('a\nb\nX');
    expect(last).not.toContain('Warning');
  });

  it('numbers seams in a CRLF file by the lines the finished file has', async () => {
    fs.writeFileSync(target, 'x\r\ny\r\nx\r\ny\r\n');
    const result = String(
      await tool.handler({ path: target, old_str: 'x\n', new_str: 'X', replace_all: true }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('Xy\r\nXy\r\n');
    expect(result).toContain('two lines are now one (line 1; line 2)');
  });

  // The count the model acts on. `new_str` here contains `old_str`, so the
  // copies left in the file are not simply the ones this edit skipped: one of
  // them sits inside the text it just wrote, and the old count could not see it.
  it('counts the copies the file still holds from the text it just built', async () => {
    fs.writeFileSync(target, 'alpha\nalpha\nalpha\n');
    const result = String(
      await tool.handler({ path: target, old_str: 'alpha', new_str: 'alpha-beta' }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('alpha-beta\nalpha\nalpha\n');
    expect(result).toContain(
      '3 more copies of old_str are still in the file ' +
        '(only the first of 3 was replaced, 1 inside the new text)',
    );
  });

  it('says the same thing in the batch wording, and keeps it for the edits that did not', async () => {
    fs.writeFileSync(target, 'alpha\nalpha\nbeta\nbeta\n');
    const result = String(
      await tool.handler({
        path: target,
        edits: [
          { old_str: 'alpha', new_str: 'alpha-b' },
          { old_str: 'beta', new_str: 'B' },
        ],
      }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('alpha-b\nalpha\nB\nbeta\n');
    expect(result).toContain(
      'edit 1: 2 copies of old_str left in the file (only the first of 2 replaced, 1 inside the new text; use replace_all: true)',
    );
    expect(result).toContain(
      'edit 2: 1 copy of old_str left in the file (only the first of 2 replaced; use replace_all: true)',
    );
  });

  // A string "true" inside edits[] is the case nothing else checks:
  // `ToolRegistry.invalidArgs` type-checks the top-level properties only, and
  // read as false it would have replaced one copy and reported success.
  it('refuses a replace_all that is not a boolean, naming where it came from', async () => {
    fs.writeFileSync(target, 'alpha\n');
    await expect(
      tool.handler({
        path: target,
        edits: [{ old_str: 'alpha', new_str: 'A', replace_all: 'yes' }],
      }),
    ).rejects.toThrow('edit 1 replace_all must be true or false, not "yes"');
    await expect(
      tool.handler({ path: target, old_str: 'alpha', new_str: 'A', replace_all: 'yes' }),
    ).rejects.toThrow('replace_all must be true or false, not "yes"');
    expect(fs.readFileSync(target, 'utf8')).toBe('alpha\n');
  });

  it('advertises replace_all at the top level and inside every edit', () => {
    const parameters = tool.definition.function.parameters as {
      properties: Record<
        string,
        { type: string } & { items?: { properties?: Record<string, unknown> } }
      >;
    };
    expect(parameters.properties['replace_all']).toMatchObject({ type: 'boolean' });
    expect(parameters.properties['edits']?.items?.properties).toHaveProperty('replace_all');
    expect(tool.definition.function.description).toContain('replace_all: true');
  });
});
