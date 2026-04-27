import * as vscode from 'vscode';

/**
 * Provides inline CodeLens decorations for Keep/Undo on files modified by the agent.
 * Appears at the top of any file that has a pending checkpoint.
 *
 * Usage in extension.ts:
 *   const provider = new KeepUndoCodeLensProvider(onKeep, onUndo);
 *   context.subscriptions.push(
 *     vscode.languages.registerCodeLensProvider('*', provider),
 *     vscode.commands.registerCommand('forge.keep', provider.handleKeep, provider),
 *     vscode.commands.registerCommand('forge.undo', provider.handleUndo, provider),
 *     provider,
 *   );
 *
 *   // When the agent writes files:
 *   provider.markPending(['/abs/path/to/file.ts']);
 *
 *   // After Keep or Undo resolves:
 *   provider.clearPending();
 */
export class KeepUndoCodeLensProvider implements vscode.CodeLensProvider {
  private readonly pendingFiles = new Set<string>();
  private readonly _emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses: vscode.Event<void> = this._emitter.event;

  constructor(
    private readonly onKeep: () => void,
    private readonly onUndo: () => void,
  ) {}

  /** Call when a new checkpoint is created with modified files. */
  markPending(filePaths: string[]): void {
    filePaths.forEach((p) => this.pendingFiles.add(p));
    this._emitter.fire();
  }

  /** Clear all pending files (after Keep or Undo). */
  clearPending(): void {
    this.pendingFiles.clear();
    this._emitter.fire();
  }

  /**
   * Command handler for forge.keep.
   * Register with: vscode.commands.registerCommand('forge.keep', provider.handleKeep, provider)
   */
  handleKeep(): void {
    this.onKeep();
    this.clearPending();
  }

  /**
   * Command handler for forge.undo.
   * Register with: vscode.commands.registerCommand('forge.undo', provider.handleUndo, provider)
   */
  handleUndo(): void {
    this.onUndo();
    this.clearPending();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.pendingFiles.has(document.uri.fsPath)) return [];

    const range = new vscode.Range(0, 0, 0, 0);

    return [
      new vscode.CodeLens(range, {
        title: '✓ Keep Forge changes',
        command: 'forge.keep',
        tooltip: 'Accept all changes from the last Forge agent turn',
      }),
      new vscode.CodeLens(range, {
        title: '↩ Undo Forge changes',
        command: 'forge.undo',
        tooltip: 'Revert all changes from the last Forge agent turn',
      }),
    ];
  }

  dispose(): void {
    this._emitter.dispose();
  }
}
