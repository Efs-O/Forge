import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { describePathMiss } from '../../src/tools/pathErrorHint';
import { toolErrorText } from '../../src/tools/toolErrorText';
import { resolveRealWorkspacePath } from '../../src/util/WorkspacePaths';
import { WorkspacePathMissingError } from '../../src/util/workspacePathMissingError';

let root: string;

function setWorkspace(folder: string): void {
  const workspace = vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
  };
  workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
}

function makeWorkspace(): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-path-miss-')));
  setWorkspace(root);
  return root;
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('shared missing workspace path errors', () => {
  it('formats a relative missing path with its resolution base and find_files', async () => {
    const workspaceRoot = makeWorkspace();
    const requestedPath = 'missing/file.txt';
    let missing: WorkspacePathMissingError | undefined;
    try {
      await resolveRealWorkspacePath(requestedPath, workspaceRoot);
    } catch (error) {
      if (!(error instanceof WorkspacePathMissingError)) throw error;
      missing = error;
    }

    expect(missing).toBeInstanceOf(WorkspacePathMissingError);
    expect(toolErrorText('open_file', missing)).toBe(
      `Error: ${describePathMiss('open_file', requestedPath, missing)}`,
    );
  });

  it('formats an absolute missing path as used as given', async () => {
    const workspaceRoot = makeWorkspace();
    const requestedPath = path.join(workspaceRoot, 'missing.txt');
    let missing: WorkspacePathMissingError | undefined;
    try {
      await resolveRealWorkspacePath(requestedPath, workspaceRoot);
    } catch (error) {
      if (!(error instanceof WorkspacePathMissingError)) throw error;
      missing = error;
    }

    expect(toolErrorText('open_file', missing)).toBe(
      `Error: ${describePathMiss('open_file', requestedPath, missing)}`,
    );
  });

  it('keeps the Node code and message while retaining the requested spelling', async () => {
    const workspaceRoot = makeWorkspace();
    const requestedPath = '.\\missing\\file.txt';
    let missing: WorkspacePathMissingError | undefined;
    try {
      await resolveRealWorkspacePath(requestedPath, workspaceRoot);
    } catch (error) {
      if (!(error instanceof WorkspacePathMissingError)) throw error;
      missing = error;
    }

    expect(missing).toBeInstanceOf(WorkspacePathMissingError);
    expect(missing?.requestedPath).toBe(requestedPath);
    expect(missing?.code).toBe('ENOENT');
    expect(missing?.message).toMatch(/^ENOENT:/u);
  });

  it('formats a thrown path miss using its captured workspace root', () => {
    const requestedPath = 'missing/file.txt';
    const workspaceRoot = 'N:/project';
    const missing = new WorkspacePathMissingError(
      requestedPath,
      'ENOENT',
      "ENOENT: no such file or directory, open 'missing/file.txt'",
      workspaceRoot,
    );

    expect(toolErrorText('open_file', missing)).toBe(
      `Error: open_file: nothing exists there. "missing/file.txt" resolved against the workspace root N:/project. ENOENT: no such file or directory, open 'missing/file.txt' The workspace root is often not the project root, so a path that looks right for the project can still miss. Use find_files to locate it before retrying.`,
    );
  });

  it('leaves an outside-workspace error unchanged', () => {
    const outside = path.join(os.tmpdir(), 'outside.txt');
    expect(toolErrorText('open_file', new Error(`Path resolves outside the workspace: ${outside}`))).toBe(
      `Error: Path resolves outside the workspace: ${outside}`,
    );
  });

  it('leaves non-path errors unchanged', () => {
    expect(toolErrorText('open_file', new Error('something else failed'))).toBe(
      'Error: something else failed',
    );
  });
});
