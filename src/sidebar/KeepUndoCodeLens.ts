import * as vscode from 'vscode';
import type { DiffDecorations } from './DiffDecorations';

export class KeepUndoCodeLensProvider implements vscode.CodeLensProvider {
  private readonly pendingFiles = new Set<string>();
  private readonly _emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses: vscode.Event<void> = this._emitter.event;

  constructor(
    private readonly onKeep: () => void,
    private readonly onUndo: () => void,
    private readonly diffDecorations: DiffDecorations,
  ) {}

  markPending(filePaths: string[]): void {
    filePaths.forEach((p) => this.pendingFiles.add(p));
    this._emitter.fire();
  }

  clearPending(): void {
    this.pendingFiles.clear();
    this._emitter.fire();
  }

  handleKeep(): void {
    this.onKeep();
    this.diffDecorations.clearAll();
    this.clearPending();
  }

  handleUndo(): void {
    this.onUndo();
    this.diffDecorations.clearAll();
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
