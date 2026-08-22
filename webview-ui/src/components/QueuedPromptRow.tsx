import React from 'react';

interface Props {
  text: string;
  attachmentCount: number;
  onSteer: () => void;
  onCancel: () => void;
}

/** A local-only row: it becomes a normal user message only when its turn starts. */
export function QueuedPromptRow({
  text,
  attachmentCount,
  onSteer,
  onCancel,
}: Props): React.ReactElement {
  const attachmentLabel = attachmentCount
    ? ` · ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
    : '';
  return (
    <div className="msg-wrapper queued-prompt">
      <span className="msg-role role-user">You</span>
      <div className="msg user msg-queued">{text || 'Attachment queued'}</div>
      <div className="queued-prompt-actions">
        <span className="queued-prompt-status">Queued{attachmentLabel}</span>
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
