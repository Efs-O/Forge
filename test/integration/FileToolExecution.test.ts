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
import { makeListDirectoryTool } from '../../src/tools/listDirectoryTool';
import {
  makeCreateDirectoryTool,
  makeDeleteFileTool,
  makeMoveFileTool,
} from '../../src/tools/fileEditTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { MAX_READ_FILE_CHARS } from '../../src/tools/resultCap';

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

  // read_file was uncapped and decoded anything as UTF-8, so a 1.3 MB PNG
  // became ~1.3 M characters of replacement glyphs and exhausted a one-slot
  // context in a single tool result.
  it('refuses to decode an image and names view_image instead', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    fs.writeFileSync(path.join(root, 'shot.png'), png);
    await expect(makeReadFileTool().handler({ path: 'shot.png' })).rejects.toThrow('view_image');
  });

  it('refuses a non-image binary file rather than returning mojibake', async () => {
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02, 0x03]));
    await expect(makeReadFileTool().handler({ path: 'blob.bin' })).rejects.toThrow(
      'appears to be a binary file',
    );
  });

  it('caps an oversized text read and says how to get the rest', async () => {
    fs.writeFileSync(path.join(root, 'huge.txt'), 'x'.repeat(MAX_READ_FILE_CHARS + 500), 'utf8');
    const result = (await makeReadFileTool().handler({ path: 'huge.txt' })) as string;
    expect(result.length).toBeLessThan(MAX_READ_FILE_CHARS + 300);
    expect(result).toContain('truncated by read_file');
    expect(result).toContain('start_line');
  });

  it('executes create, list, replace, structured edit, move, and delete handlers', async () => {
    await makeCreateDirectoryTool().handler({ path: 'work' });
    fs.writeFileSync(path.join(root, 'work/source.txt'), 'alpha\nbeta\n', 'utf8');

    const listed = (await makeListDirectoryTool().handler({ path: 'work' })) as string;
    expect(listed).toContain('[file] source.txt');
    // Size and age are what let the agent tell a growing file from a stalled
    // one without waiting on a process that prints nothing.
    expect(listed).toMatch(/\[file\] source\.txt \(11 B, \d+s ago\)/u);
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
