import React from 'react';

interface Props {
  toolName: string;
  detail: string;
  onApprove: () => void;
  onDeny: () => void;
}

const WarningIcon = (): React.ReactElement => (
  <svg className="confirm-warning-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
  </svg>
);

export function ConfirmationDialog({ toolName, detail, onApprove, onDeny }: Props): React.ReactElement {
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label={`Confirm tool: ${toolName}`}>
      <div className="confirm-dialog">
        <div className="confirm-header">
          <WarningIcon />
          <span className="confirm-tool-name">{toolName}</span>
        </div>
        <pre className="confirm-detail">{detail}</pre>
        <div className="confirm-actions">
          <button className="confirm-btn-deny" type="button" onClick={onDeny}>Deny</button>
          <button className="confirm-btn-approve" type="button" onClick={onApprove}>Approve</button>
        </div>
      </div>
    </div>
  );
}
