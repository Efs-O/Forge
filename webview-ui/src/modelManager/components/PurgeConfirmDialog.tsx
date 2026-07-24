import React, { useState } from 'react';

interface Props {
  modelName: string;
  onConfirm: (typedName: string) => void;
  onCancel: () => void;
}

/** Typed-name confirmation for purge (config + disk deletion) — the in-webview
 *  half of Q7's confirmation flow; the host also re-verifies the typed name
 *  before touching disk. */
export function PurgeConfirmDialog({ modelName, onConfirm, onCancel }: Props): React.ReactElement {
  const [typed, setTyped] = useState('');
  const matches = typed === modelName;

  return (
    <div className="mm-modal-backdrop" onClick={onCancel}>
      <div
        className="mm-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3>Permanently delete "{modelName}"?</h3>
        <p>
          This deletes the GGUF file, any sibling mmproj file, and the parent snapshot directory if
          it becomes empty — then removes the config entry. This cannot be undone.
        </p>
        <p>
          Type <strong>{modelName}</strong> to confirm:
        </p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches) onConfirm(typed);
            if (e.key === 'Escape') onCancel();
          }}
        />
        <div className="mm-modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="mm-danger-btn" disabled={!matches} onClick={() => onConfirm(typed)}>
            Delete permanently
          </button>
        </div>
      </div>
    </div>
  );
}
