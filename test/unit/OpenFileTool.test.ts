import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeCommand, openTextDocument, showTextDocument } = vi.hoisted(() => ({
  executeCommand: vi.fn().mockResolvedValue(undefined),
  openTextDocument: vi.fn().mockResolvedValue({ lineCount: 1 }),
  showTextDocument: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('vscode', () => ({
  Range: class {
    constructor(...positions: number[]) {
      Object.assign(this, { positions });
    }
  },
  Uri: { file: (fsPath: string) => ({ fsPath, path: fsPath }) },
  commands: { executeCommand },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    openTextDocument,
  },
  window: { showTextDocument },
}));

import { makeOpenFileTool } from '../../src/tools/uxTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

describe('open_file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens known binary extensions with VS Code native open', async () => {
    const tool = makeOpenFileTool();
    const binaryPath = path.join(process.cwd(), 'assets', 'image.PNG');
    await expect(tool.handler({ path: binaryPath })).resolves.toContain('Opened');
    expect(executeCommand).toHaveBeenCalledWith('vscode.open', {
      fsPath: binaryPath,
      path: binaryPath,
    });
    expect(openTextDocument).not.toHaveBeenCalled();
  });

  it('keeps text files on the text document path', async () => {
    const tool = makeOpenFileTool();
    await tool.handler({ path: path.join(process.cwd(), 'README.md') });
    expect(openTextDocument).toHaveBeenCalledOnce();
    expect(showTextDocument).toHaveBeenCalledOnce();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reports a requested line past EOF after opening at the final line', async () => {
    openTextDocument.mockResolvedValueOnce({ lineCount: 3 });
    const tool = makeOpenFileTool();
    await expect(tool.handler({ path: 'src/a.ts', line: 9 })).resolves.toBe(
      'line 9 is past the end of the file (3 lines); opened at line 3.',
    );
    expect(showTextDocument).toHaveBeenCalledOnce();
  });

  it('refuses a quoted line number and names the required integer range', () => {
    const tool = makeOpenFileTool();
    expect(new ToolRegistry().invalidArgs(tool, { path: 'src/a.ts', line: '2' })).toBe(
      'open_file: "line" must be a JSON integer in range at least 1, not a string. ' +
        'Resend the call with line as 1.',
    );
  });
});
