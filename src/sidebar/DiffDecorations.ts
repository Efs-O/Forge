import * as fs from 'fs';
import * as vscode from 'vscode';
import { computeDiff } from './DiffUtils';

const MAX_DECORATED_LINES = 300;

/**
 * Applies green/red line-level decorations directly in the editor after file writes.
 * Green background = added lines. Red overview-ruler + left border = removal point.
 * Decorations persist until clearAll() is called (on Keep or Undo).
 */
export class DiffDecorations {
  private readonly addedType: vscode.TextEditorDecorationType;
  private readonly removedType: vscode.TextEditorDecorationType;
  private readonly pending = new Map<string, { added: vscode.Range[]; removed: vscode.Range[] }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.addedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.insertedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.removedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
      overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.removedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) this.reapply(editor);
      }),
    );
  }

  /**
   * Compute diff between beforeContent and the current file on disk,
   * then apply decorations to any visible editor for that file.
   * If the file is not yet visible, decorations are stored and applied
   * when the editor becomes visible via onDidChangeVisibleTextEditors.
   */
  apply(resolvedPath: string, beforeContent: string | null): void {
    if (!fs.existsSync(resolvedPath)) return;

    const afterContent = fs.readFileSync(resolvedPath, 'utf8');
    const hunks = computeDiff(beforeContent ?? '', afterContent);
    if (!hunks || hunks.length === 0) return;

    const added: vscode.Range[] = [];
    const removed: vscode.Range[] = [];
    let addedCount = 0;

    for (const hunk of hunks) {
      let newLine = hunk.newStart - 1; // 0-based
      let hunkHasRemovals = false;
      let hunkHasAdditions = false;

      for (const line of hunk.lines) {
        if (line.kind === 'added') {
          if (addedCount < MAX_DECORATED_LINES) {
            added.push(new vscode.Range(newLine, 0, newLine, 0));
            addedCount++;
          }
          newLine++;
          hunkHasAdditions = true;
        } else if (line.kind === 'context') {
          newLine++;
        } else {
          hunkHasRemovals = true;
        }
      }

      // Pure-removal hunk: mark insertion point with left border
      if (hunkHasRemovals && !hunkHasAdditions) {
        const markerLine = Math.max(0, hunk.newStart - 1);
        removed.push(new vscode.Range(markerLine, 0, markerLine, 0));
      }
    }

    this.pending.set(resolvedPath, { added, removed });

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === resolvedPath) {
        this.reapply(editor);
        return;
      }
    }
  }

  private reapply(editor: vscode.TextEditor): void {
    const entry = this.pending.get(editor.document.uri.fsPath);
    if (!entry) return;
    editor.setDecorations(this.addedType, entry.added);
    editor.setDecorations(this.removedType, entry.removed);
  }

  /** Clear all decorations from tracked files. Call on Keep or Undo. */
  clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.pending.has(editor.document.uri.fsPath)) {
        editor.setDecorations(this.addedType, []);
        editor.setDecorations(this.removedType, []);
      }
    }
    this.pending.clear();
  }

  dispose(): void {
    this.clearAll();
    this.addedType.dispose();
    this.removedType.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
