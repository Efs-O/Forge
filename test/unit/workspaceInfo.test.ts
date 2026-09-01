import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { workspaceInfoMessage } from '../../src/sidebar/workspaceInfo';

const setFolders = (folders: Array<{ name: string; fsPath: string }>): void => {
  vscode.workspace.workspaceFolders.splice(0);
  for (const folder of folders)
    vscode.workspace.workspaceFolders.push({ name: folder.name, uri: { fsPath: folder.fsPath } });
};

afterEach(() => vscode.workspace.workspaceFolders.splice(0));

describe('workspaceInfoMessage', () => {
  it('reports the first folder, which is the only one tools resolve against', () => {
    setFolders([
      { name: 'Forge', fsPath: 'N:/forge' },
      { name: 'Qwen', fsPath: 'N:/qwen' },
    ]);

    expect(workspaceInfoMessage('N:/forge')).toEqual({
      type: 'workspaceInfo',
      name: 'Forge',
      path: 'N:/forge',
      extraRoots: 1,
      stale: false,
    });
  });

  it('marks the root stale when the live first folder is not the activation root', () => {
    // The exact case the header exists for: the user opened another project,
    // but delegation and the remote workspace id still hold the old root.
    setFolders([{ name: 'Qwen', fsPath: 'N:/qwen' }]);

    expect(workspaceInfoMessage('N:/forge')).toMatchObject({
      name: 'Qwen',
      extraRoots: 0,
      stale: true,
    });
  });

  it('does not call an empty folder list stale when Forge started without one', () => {
    expect(workspaceInfoMessage('')).toEqual({
      type: 'workspaceInfo',
      name: '',
      path: '',
      extraRoots: 0,
      stale: false,
    });
  });
});
