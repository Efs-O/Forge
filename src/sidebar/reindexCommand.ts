/**
 * The `/reindex` command: rebuild the semantic code index, with progress.
 *
 * Split out of `SidebarProvider` — it is a self-contained VS Code interaction
 * that reports to both the notification area and the chat.
 */

import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import type { IndexManager } from '../search/IndexManager';

export async function reindexCodebase(
  indexManager: IndexManager,
  post: (msg: HostToWebview) => void,
): Promise<void> {
  try {
    const summary = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Forge: rebuilding semantic code index...',
        cancellable: false,
      },
      async () => indexManager.reindex(),
    );
    const message = `Forge: semantic index rebuilt (${summary.filesIndexed} files, ${summary.chunksIndexed} chunks).`;
    post({ type: 'token', text: `\n> ${message}\n` });
    void vscode.window.showInformationMessage(message);
  } catch (err) {
    const message = `Forge: ${(err as Error).message}`;
    post({ type: 'error', message });
    void vscode.window.showErrorMessage(message);
  }
}
