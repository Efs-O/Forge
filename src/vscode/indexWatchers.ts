import * as vscode from 'vscode';
import type { IndexManager } from '../search/IndexManager';

/**
 * The index file watchers (save/create/delete/rename → markDirty/removePath).
 * Registered at the same point in the activation sequence as the webview
 * provider so the `context.subscriptions` disposal order is preserved.
 */
export function registerIndexWatchers(
  context: vscode.ExtensionContext,
  indexManager: IndexManager,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      indexManager.markDirty(document.uri.fsPath);
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      for (const file of event.files) indexManager.markDirty(file.fsPath);
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const file of event.files) indexManager.removePath(file.fsPath);
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        indexManager.removePath(file.oldUri.fsPath);
        indexManager.markDirty(file.newUri.fsPath);
      }
    }),
  );
}
