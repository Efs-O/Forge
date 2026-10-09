import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeCommand, openTextDocument, showTextDocument } = vi.hoisted(() => ({
  executeCommand: vi.fn().mockResolvedValue(undefined),
  openTextDocument: vi.fn().mockResolvedValue({ lineCount: 1 }),
  showTextDocument: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath, path: fsPath }) },
  commands: { executeCommand },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    openTextDocument,
  },
  window: { showTextDocument },
}));

import { makeOpenFileTool } from '../../src/tools/uxTools';

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
});
