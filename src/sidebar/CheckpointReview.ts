import * as path from 'path';
import * as vscode from 'vscode';

export const CHECKPOINT_REVIEW_SCHEME = 'forge-checkpoint';

/** Opening dozens of diff tabs at once is worse than not offering the button. */
const MAX_REVIEW_TABS = 12;

export interface ReviewEntry {
  filePath: string;
  /** Pre-turn contents, or null when the turn created the file. */
  original: string | null;
}

/**
 * Backs the checkpoint bar's Review action: serves each file's pre-turn contents
 * as a read-only virtual document so VS Code's native diff editor can show the
 * turn's changes against the real file on disk.
 */
export class CheckpointReview implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      CHECKPOINT_REVIEW_SCHEME,
      this,
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  async open(entries: ReviewEntry[]): Promise<void> {
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('Forge: no file changes to review.');
      return;
    }

    const shown = entries.slice(0, MAX_REVIEW_TABS);
    for (const entry of shown) {
      const uriPath = entry.filePath.replace(/\\/g, '/');
      this.contents.set(uriPath, entry.original ?? '');
      const before = vscode.Uri.from({ scheme: CHECKPOINT_REVIEW_SCHEME, path: uriPath });
      const after = vscode.Uri.file(entry.filePath);
      const label = path.basename(entry.filePath);
      const title = entry.original === null ? `${label} (new file)` : `${label} — this turn`;
      await vscode.commands.executeCommand('vscode.diff', before, after, title, {
        preview: false,
      });
    }

    if (entries.length > shown.length) {
      void vscode.window.showInformationMessage(
        `Forge: showing ${shown.length} of ${entries.length} changed files.`,
      );
    }
  }

  dispose(): void {
    this.contents.clear();
    this.registration.dispose();
  }
}
