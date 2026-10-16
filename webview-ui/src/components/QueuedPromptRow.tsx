import React from 'react';

interface Props {
  text: string;
  attachmentCount: number;
  tell?: boolean;
  sendingNow?: boolean;
  onSendNow: () => void;
  onCancel: () => void;
}

/** A local-only row: it becomes a normal user message only when its turn starts. */
export function QueuedPromptRow({
  text,
  attachmentCount,
  tell = false,
  sendingNow = false,
  onSendNow,
  onCancel,
}: Props): React.ReactElement {
  const attachmentLabel = attachmentCount
    ? ` · ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
    : '';
  return (
    <div className="msg-wrapper queued-prompt">
      <div className="queued-prompt-card">
        <div className="msg user msg-queued">{text || 'Attachment queued'}</div>
        <div className="queued-prompt-actions">
          <span className="queued-prompt-status">
            {sendingNow
              ? 'Stopping the turn to send this…'
              : tell
                ? 'Will reach Forge at its next step'
                : `Sends when this turn ends${attachmentLabel}`}
          </span>
          <button
            className="btn-action"
            type="button"
            disabled={sendingNow}
            title="Stop the running turn and send this now"
            onClick={onSendNow}
          >
            Send now
          </button>
          <button className="btn-action" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
