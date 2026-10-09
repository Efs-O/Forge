import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAppendFileTool, makeWriteFileTool } from '../../src/tools/builtinTools';
import { makeDeleteFileTool, makeMoveFileTool } from '../../src/tools/fileEditTools';
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

  it('writes the matched edits of a batch and names the missed ones', async () => {
    const file = path.join(extra, 'partial-batch.txt');
    fs.writeFileSync(file, 'alpha beta gamma');
    const result = String(
      await makeEditFileTool(roots).handler({
        path: file,
        edits: [
          { old_str: 'alpha', new_str: 'a' },
          { old_str: 'BETA', new_str: 'b' },
          { old_str: 'gamma', new_str: 'g' },
          { old_str: 'delta', new_str: 'd' },
        ],
      }),
    );
    expect(result).toMatch(/^Partly applied: edit\(s\) 1, 3 of 4 .*Edit\(s\) 2, 4 not found/su);
    expect(result).toMatch(/\nEdit 2:.*\nEdit 4:/su);
    expect(fs.readFileSync(file, 'utf8')).toBe('a beta g');
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

  it('deletes paths independently and keeps the trash default for each path', async () => {
    const first = path.join(root, 'first.txt');
    const fromExtra = path.join(extra, 'extra.txt');
    fs.writeFileSync(first, 'one');
    fs.writeFileSync(fromExtra, 'two');

    const result = await makeDeleteFileTool(roots).handler({
      paths: [first, path.join(root, 'missing.txt'), path.join(os.tmpdir(), 'outside.txt'), fromExtra],
    });

    expect(result).toContain(`Moved to recycle bin: ${first}`);
    expect(result).toContain(`Missing: ${path.join(root, 'missing.txt')}`);
    expect(result).toContain(`Failed: ${path.join(os.tmpdir(), 'outside.txt')}:`);
    expect(result).toContain(`Moved to recycle bin: ${fromExtra}`);
    expect(vscode.workspace.fs.lastDeleteOptions).toEqual({ recursive: false, useTrash: true });
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(fromExtra)).toBe(false);
  });

  it('requires exactly one of path and paths and bounds path batches to 50', async () => {
    const tool = makeDeleteFileTool(roots);
    await expect(tool.handler({})).rejects.toThrow(/exactly one/);
    await expect(tool.handler({ path: 'a', paths: ['b'] })).rejects.toThrow(/exactly one/);
    await expect(tool.handler({ paths: Array.from({ length: 51 }, () => 'a') })).rejects.toThrow(
      /1–50 strings/,
    );
    // A batch that deleted nothing is a failed call, not a success string.
    await expect(
      tool.handler({ paths: [path.join(root, 'gone-1.txt'), path.join(root, 'gone-2.txt')] }),
    ).rejects.toThrow(/Missing: .*gone-1\.txt[\s\S]*Missing: .*gone-2\.txt/);
  });
});
