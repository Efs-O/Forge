/**
 * Which folder this window's tools actually resolve against, and what to do
 * when that folder list changes underneath them.
 *
 * Every `path`, `cwd`, and glob resolves against `workspaceFolders[0]` — not
 * the folder the user believes they opened. A multi-root workspace listing
 * another project first silently aims the whole agent at it, and the only
 * evidence was the model reporting a surprising root mid-turn. Both exports
 * exist to make that visible before a turn runs.
 */

import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';

/**
 * `activationRoot` is the root every by-value consumer — delegation, the
 * instructions loader, the checkpoint store, the remote workspace id hash —
 * was constructed with. A mismatch against the live list is what makes the
 * header say the window needs reloading rather than quietly aiming elsewhere.
 */
export function workspaceInfoMessage(activationRoot: string): HostToWebview {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = folders[0]?.uri.fsPath ?? '';
  return {
    type: 'workspaceInfo',
    name: folders[0]?.name ?? '',
    path: root,
    extraRoots: Math.max(0, folders.length - 1),
    stale: root !== activationRoot,
  };
}

/**
 * The root captured at activation is handed by value to half the extension, so
 * a mid-session folder change cannot be applied in place. Before this listener
 * the change was simply invisible: tools kept resolving against the old root
 * while the explorer showed a different project. Say so, and offer the one
 * action that actually fixes it.
 */
export function watchWorkspaceFolders(
  activationRoot: string,
  republish: () => void,
): vscode.Disposable {
  return vscode.workspace.onDidChangeWorkspaceFolders(() => {
    republish();
    const next = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (next === activationRoot) return;
    void vscode.window
      .showWarningMessage(
        `Forge is still using ${activationRoot || 'no folder'} as its workspace root. ` +
          'Reload the window to follow the new folder list.',
        'Reload Window',
      )
      .then((choice) => {
        if (choice === 'Reload Window')
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
  });
}
