import React from 'react';
import { vscode } from '../vscode';

interface Props {
  visible: boolean;
  fileCount: number;
  added: number;
  removed: number;
}

/**
 * One summary row for the turn's file changes. Dismissing *is* keeping: the
 * writes already landed on disk, and `keep` only releases the undo snapshot and
 * clears the in-editor decorations — a separate "Keep" button read as though the
 * changes were unsaved until pressed.
 */
export function CheckpointBar({
  visible,
  fileCount,
  added,
  removed,
}: Props): React.ReactElement | null {
  if (!visible) return null;

  const summary =
    fileCount > 0 ? `Edited ${fileCount} file${fileCount === 1 ? '' : 's'}` : 'Files changed';

  return (
    <div id="checkpoint-bar">
      <span id="checkpoint-label">{summary}</span>
      {added > 0 && <span className="diff-stat diff-stat-added">+{added}</span>}
      {removed > 0 && <span className="diff-stat diff-stat-removed">−{removed}</span>}
      <button
        className="btn-undo"
        onClick={() => vscode.postMessage({ type: 'undo' })}
        title="Restore files to their state before this turn"
      >
        ↩ Undo
      </button>
      <button
        className="btn-review"
        onClick={() => vscode.postMessage({ type: 'reviewCheckpoint' })}
        title="Open this turn's changes in the diff editor"
      >
        Review
      </button>
      <button
        className="btn-dismiss"
        onClick={() => vscode.postMessage({ type: 'keep' })}
        title="Keep the changes and dismiss — clears the undo snapshot and editor markers"
        aria-label="Keep changes and dismiss"
      >
        ✕
      </button>
    </div>
  );
}
