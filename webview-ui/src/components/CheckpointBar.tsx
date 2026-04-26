import React from 'react';
import { vscode } from '../vscode';

interface Props {
  visible: boolean;
}

export function CheckpointBar({ visible }: Props): React.ReactElement | null {
  if (!visible) return null;

  return (
    <div id="checkpoint-bar">
      <span id="checkpoint-label">Files changed this turn:</span>
      <button
        className="btn-undo"
        onClick={() => vscode.postMessage({ type: 'undo' })}
        title="Restore files to their state before this turn"
      >
        ↩ Undo
      </button>
      <button
        className="btn-keep"
        onClick={() => vscode.postMessage({ type: 'keep' })}
        title="Accept the changes from this turn"
      >
        ✓ Keep
      </button>
    </div>
  );
}
