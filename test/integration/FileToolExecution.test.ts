import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeInsertCodeTool,
  makeReadFileTool,
  makeReplaceSelectionTool,
  makeWriteFileTool,
} from '../../src/tools/builtinTools';
import { makeListDirectoryTool } from '../../src/tools/dirTools';
import {
  makeCreateDirectoryTool,
  makeDeleteFileTool,
  makeMoveFileTool,
  makeEditFileTool,
} from '../../src/tools/fileEditTools';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';

describe('isolated file and directory tool execution', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-file-tools-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads ranges and writes files only inside the temporary workspace fixture', async () => {
    await makeWriteFileTool().handler({ path: 'nested/example.txt', content: 'one\ntwo\nthree' });
    expect(fs.readFileSync(path.join(root, 'nested/example.txt'), 'utf8')).toBe('one\ntwo\nthree');
    await expect(
      makeReadFileTool().handler({ path: 'nested/example.txt', start_line: 2, end_line: 3 }),
    ).resolves.toBe('two\nthree');
    await expect(
      makeReadFileTool().handler({ path: 'nested/example.txt', start_line: 4, end_line: 2 }),
    ).rejects.toThrow('past end_line');
  });

  it('executes create, list, replace, structured edit, move, and delete handlers', async () => {
    await makeCreateDirectoryTool().handler({ path: 'work' });
    fs.writeFileSync(path.join(root, 'work/source.txt'), 'alpha\nbeta\n', 'utf8');

    await expect(makeListDirectoryTool().handler({ path: 'work' })).resolves.toContain(
      '[file] source.txt',
    );
    await makeEditFileTool().handler({
      filepath: 'work/source.txt',
      old_str: 'alpha',
      new_str: 'first',
    });
    await makeApplyLineEditsTool().handler({
      path: 'work/source.txt',
      operations: [
        {
          start_line: 2,
          end_line: 2,
          expected_lines: ['beta'],
          replacement_lines: ['second'],
        },
      ],
    });
    expect(fs.readFileSync(path.join(root, 'work/source.txt'), 'utf8')).toBe('first\nsecond\n');

    await makeMoveFileTool().handler({
      source: 'work/source.txt',
      destination: 'moved/result.txt',
    });
    expect(fs.existsSync(path.join(root, 'moved/result.txt'))).toBe(true);
    await makeDeleteFileTool().handler({ path: 'moved', recursive: true });
    expect(fs.existsSync(path.join(root, 'moved'))).toBe(false);
  });

  it('rejects stale structured edits without modifying the fixture', async () => {
    const target = path.join(root, 'stale.txt');
    fs.writeFileSync(target, 'current\n', 'utf8');
    await expect(
      makeApplyLineEditsTool().handler({
        path: 'stale.txt',
        operations: [
          {
            start_line: 1,
            end_line: 1,
            expected_lines: ['old'],
            replacement_lines: ['new'],
          },
        ],
      }),
    ).rejects.toThrow('stale');
    expect(fs.readFileSync(target, 'utf8')).toBe('current\n');
  });

  it('executes active-editor replacement and insertion through controlled adapters', async () => {
    const replace = vi.fn();
    const insert = vi.fn();
    const editor = {
      document: { uri: vscode.Uri.file(path.join(root, 'editor.ts')) },
      selection: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 3)),
      edit: async (
        callback: (builder: { replace: typeof replace; insert: typeof insert }) => void,
      ) => {
        callback({ replace, insert });
        return true;
      },
    };
    (vscode.window as unknown as { activeTextEditor: typeof editor }).activeTextEditor = editor;

    await makeReplaceSelectionTool().handler({ text: 'replacement' });
    await makeInsertCodeTool().handler({ text: 'const value = 1;', line: 2 });
    expect(replace).toHaveBeenCalledWith(editor.selection, 'replacement');
    expect(insert).toHaveBeenCalledWith(new vscode.Position(2, 0), 'const value = 1;\n');
  });
});
