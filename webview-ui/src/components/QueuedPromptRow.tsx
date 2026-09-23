import React from 'react';

interface Props {
  text: string;
  attachmentCount: number;
  tell?: boolean;
  onCancel: () => void;
}

/** A local-only row: it becomes a normal user message only when its turn starts. */
export function QueuedPromptRow({
  text,
  attachmentCount,
  tell = false,
  onCancel,
}: Props): React.ReactElement {
  const attachmentLabel = attachmentCount
    ? ` · ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
    : '';
  return (
    <div className="msg-wrapper queued-prompt">
      <div className="msg user msg-queued">{text || 'Attachment queued'}</div>
      <div className="queued-prompt-actions">
        <span className="queued-prompt-status">
          {tell
            ? 'Will reach Forge at its next step'
            : `Sends when this turn ends${attachmentLabel}`}
        </span>
        {!tell && (
          <button className="btn-action" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
