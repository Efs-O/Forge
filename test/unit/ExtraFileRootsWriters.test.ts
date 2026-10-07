import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAppendFileTool, makeWriteFileTool } from '../../src/tools/builtinTools';
import { makeMoveFileTool } from '../../src/tools/fileEditTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';

/**
 * config.yaml `extra_file_roots` once reached only create_directory and
 * delete_file. write_file refused a configured folder with "add its folder to
 * extra_file_roots", so the agent wrote a PowerShell script to do the write
 * instead. Every file-writing tool must accept a path inside an extra root.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-extra-ws-'));
const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-extra-root-'));
const roots = (): readonly string[] => [extra];

afterAll(() => {
  for (const dir of [root, extra]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('every file-writing tool honours extra_file_roots', () => {
  beforeEach(() => {
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });
  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
  });

  it('writes, appends, edits, line-edits and moves inside an extra root', async () => {
    const file = path.join(extra, 'note.txt');
    await makeWriteFileTool(roots).handler({ path: file, content: 'alpha\n' });
    await makeAppendFileTool(roots).handler({ path: file, content: 'beta\n' });
    await makeEditFileTool(roots).handler({ path: file, old_str: 'alpha', new_str: 'first' });
    await makeApplyLineEditsTool(roots).handler({
      path: file,
      operations: [
        { start_line: 2, end_line: 2, expected_lines: ['beta'], replacement_lines: ['second'] },
      ],
    });
    const moved = path.join(extra, 'sub', 'moved.txt');
    await makeMoveFileTool(roots).handler({ source: file, destination: moved });
    expect(fs.readFileSync(moved, 'utf8')).toBe('first\nsecond\n');
  });

  it('reports the number of edits for a multi-edit call', async () => {
    const file = path.join(extra, 'multi-edit.txt');
    fs.writeFileSync(file, 'alpha beta');
    await expect(
      makeEditFileTool(roots).handler({
        path: file,
        edits: [
          { old_str: 'alpha', new_str: 'first' },
          { old_str: 'beta', new_str: 'second' },
        ],
      }),
    ).resolves.toBe(`Applied 2 edits to ${file}`);
    expect(fs.readFileSync(file, 'utf8')).toBe('first second');
  });

  it('names which other edits of a failed batch matched', async () => {
    const file = path.join(extra, 'partial-batch.txt');
    fs.writeFileSync(file, 'alpha beta gamma');
    await expect(
      makeEditFileTool(roots).handler({
        path: file,
        edits: [
          { old_str: 'alpha', new_str: 'a' },
          { old_str: 'BETA', new_str: 'b' },
          { old_str: 'gamma', new_str: 'g' },
          { old_str: 'delta', new_str: 'd' },
        ],
      }),
    ).rejects.toThrow(/\(edit 2 of 4\).*edit\(s\) 1, 3 matched; edit\(s\) 4 also did not match/su);
    expect(fs.readFileSync(file, 'utf8')).toBe('alpha beta gamma');
  });

  it('keeps the single-edit result unchanged', async () => {
    const file = path.join(extra, 'single-edit.txt');
    fs.writeFileSync(file, 'before');
    await expect(
      makeEditFileTool(roots).handler({ path: file, old_str: 'before', new_str: 'after' }),
    ).resolves.toBe('Replaced in ' + file);
  });

  it('still refuses a folder that is in neither the workspace nor an extra root', async () => {
    const elsewhere = path.join(os.tmpdir(), 'forge-extra-elsewhere', 'x.txt');
    await expect(
      makeWriteFileTool(roots).handler({ path: elsewhere, content: 'x' }),
    ).rejects.toThrow(/outside extra_file_roots/);
  });
});
