import React from 'react';

interface Props {
  toolName: string;
  detail: string;
  onApprove: () => void;
  onDeny: () => void;
}

export function ConfirmationDialog({ toolName, detail, onApprove, onDeny }: Props): React.ReactElement {
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label={`Confirm tool: ${toolName}`}>
      <div className="confirm-dialog">
        <p className="confirm-tool-name">Tool: <strong>{toolName}</strong></p>
        <pre className="confirm-detail">{detail}</pre>
        <div className="confirm-actions">
          <button className="confirm-btn-approve" onClick={onApprove}>Approve</button>
          <button className="confirm-btn-deny" onClick={onDeny}>Deny</button>
        </div>
      </div>
    </div>
  );
}
