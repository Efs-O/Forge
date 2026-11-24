import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalOffer } from '../../../src/sidebar/approvalMessages';

interface Props {
  toolName: string;
  detail: string;
  cardReason?: string;
  isDangerous?: boolean;
  allowForChat?: ApprovalOffer;
  alwaysInProject?: ApprovalOffer;
  onApprove: () => void;
  onAllowForChat: () => void;
  onAlwaysInProject: () => void;
  onDeny: () => void;
}

const WarningIcon = (): React.ReactElement => (
  <svg
    className="confirm-warning-icon"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
  </svg>
);

export function ConfirmationDialog({
  toolName,
  detail,
  cardReason,
  isDangerous,
  allowForChat,
  alwaysInProject,
  onApprove,
  onAllowForChat,
  onAlwaysInProject,
  onDeny,
}: Props): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const [actionsEnabled, setActionsEnabled] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setActionsEnabled(true), 600);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * Escape settles this card only from inside it, and nothing is focused when the
   * card opens: a card is a decision about one command, so a keystroke that was
   * meant for the transcript, the composer or another chat must not run it or
   * refuse it. The owner answers with a button.
   */
  const onPanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onDeny();
    },
    [onDeny],
  );

  return (
    <div
      ref={panelRef}
      className="docked-dialog-panel"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      role="dialog"
      aria-labelledby="confirmation-dialog-title"
    >
      <div className={`confirm-dialog${isDangerous ? ' confirm-dialog--dangerous' : ''}`}>
        <div className="confirm-header">
          <WarningIcon />
          <span id="confirmation-dialog-title" className="confirm-tool-name">
            {isDangerous ? '⚠ DANGEROUS: ' : ''}
            {toolName}
          </span>
        </div>
        <pre className="confirm-detail">{detail}</pre>
        {cardReason ? <p className="confirm-card-reason">{cardReason}</p> : null}
        {allowForChat ? (
          <p className="confirm-allow-chat-copy">
            Allow for this chat covers: {allowForChat.label}.
          </p>
        ) : null}
        <div className="confirm-actions">
          <button
            className="confirm-btn-deny"
            type="button"
            disabled={!actionsEnabled}
            onClick={onDeny}
          >
            Decline
          </button>
          {allowForChat ? (
            <button
              className="confirm-btn-approve"
              type="button"
              disabled={!actionsEnabled}
              onClick={onAllowForChat}
            >
              Allow for this chat
            </button>
          ) : null}
          {alwaysInProject ? (
            <button
              className="confirm-btn-approve"
              type="button"
              disabled={!actionsEnabled}
              onClick={onAlwaysInProject}
            >
              Always in this project
            </button>
          ) : null}
          <button
            className="confirm-btn-approve"
            type="button"
            disabled={!actionsEnabled}
            onClick={onApprove}
          >
            {isDangerous ? 'Run (I understand the risk)' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
