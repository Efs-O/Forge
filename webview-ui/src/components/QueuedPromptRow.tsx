import React from 'react';

interface Props {
  text: string;
  attachmentCount: number;
  /** The model this prompt is waiting on; null when none is selected anywhere. */
  waitingOn: string | null;
  onSteer: () => void;
  onCancel: () => void;
}

/** A local-only row: it becomes a normal user message only when its turn starts. */
export function QueuedPromptRow({
  text,
  attachmentCount,
  waitingOn,
  onSteer,
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
          {waitingOn ? `Queued — waiting on ${waitingOn}` : 'Queued'}
          {attachmentLabel}
        </span>
        <button className="btn-action" type="button" onClick={onSteer}>
          Steer
        </button>
        <button className="btn-action" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
