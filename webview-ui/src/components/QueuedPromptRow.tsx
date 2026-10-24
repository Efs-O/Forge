import React from 'react';
import { parseChatMessage } from '../../../src/sidebar/chatMessageText';

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
  const chatMessage = parseChatMessage(text);
  const attachmentLabel = attachmentCount
    ? ` · ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
    : '';
  return (
    <div className="msg-wrapper queued-prompt">
      <div className={`queued-prompt-card${chatMessage ? ' msg-chat-message' : ''}`}>
        <div className="msg user msg-queued">
          {chatMessage ? (
            <>
              <div className="agent-sender-badge">📨 From {chatMessage.fromTitle}</div>
              {chatMessage.body}
            </>
          ) : (
            text || 'Attachment queued'
          )}
        </div>
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
