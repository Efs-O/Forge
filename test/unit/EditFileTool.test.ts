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
