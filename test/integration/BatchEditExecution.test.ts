import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeReadFileTool } from '../../src/tools/builtinTools';

describe('edit_file batch form', () => {
  let root: string;
  const file = 'src/game.js';
  const original = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-batch-edit-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, file), original, 'utf8');
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const read = (): string => fs.readFileSync(path.join(root, file), 'utf8');

  it('applies several edits in one call', async () => {
    // The whole point: three edits, one round.
    const result = await makeEditFileTool().handler({
      filepath: file,
      edits: [
        { old_str: 'const a = 1;', new_str: 'const a = 10;' },
        { old_str: 'const b = 2;', new_str: 'const b = 20;' },
        { old_str: 'const c = 3;', new_str: 'const c = 30;' },
      ],
    });
    expect(read()).toBe('const a = 10;\nconst b = 20;\nconst c = 30;\n');
    expect(String(result)).toContain('3');
  });

  it('sees earlier edits when matching later ones', async () => {
    await makeEditFileTool().handler({
      filepath: file,
      edits: [
        { old_str: 'const a = 1;', new_str: 'const a = 99;' },
        { old_str: 'const a = 99;', new_str: 'const a = 100;' },
      ],
    });
    expect(read()).toContain('const a = 100;');
  });

  it('writes nothing at all when one edit does not match', async () => {
    // A partial write would leave the file in a state neither side has read.
    await expect(
      makeEditFileTool().handler({
        filepath: file,
        edits: [
          { old_str: 'const a = 1;', new_str: 'const a = 10;' },
          { old_str: 'const MISSING = 0;', new_str: 'x' },
        ],
      }),
    ).rejects.toThrow('edit 2 of 2');
    expect(read()).toBe(original);
  });

  it('still supports the single-edit form', async () => {
    const result = await makeEditFileTool().handler({
      filepath: file,
      old_str: 'const b = 2;',
      new_str: 'const b = 22;',
    });
    expect(read()).toContain('const b = 22;');
    expect(String(result)).toBe(`Replaced in ${file}`);
  });

  it('rejects a call with neither form', async () => {
    await expect(makeEditFileTool().handler({ filepath: file })).rejects.toThrow(
      'either edits[], or both old_str and new_str',
    );
  });
});

describe('read_file numbered output', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-numbered-read-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    fs.writeFileSync(path.join(root, 'f.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('numbers whole-file reads from 1', async () => {
    const out = await makeReadFileTool().handler({ path: 'f.txt', numbered: true });
    expect(String(out).split('\n').slice(0, 3)).toEqual(['1| alpha', '2| beta', '3| gamma']);
  });

  it('numbers a range with the file’s real line numbers', async () => {
    // The numbers must be absolute, or apply_line_edits operations built from a
    // ranged read would point at the wrong lines.
    const out = await makeReadFileTool().handler({
      path: 'f.txt',
      start_line: 2,
      end_line: 3,
      numbered: true,
    });
    expect(String(out)).toBe('2| beta\n3| gamma');
  });

  it('is off by default so ordinary reads are unchanged', async () => {
    const out = await makeReadFileTool().handler({ path: 'f.txt' });
    expect(String(out)).toBe('alpha\nbeta\ngamma\n');
  });
});
