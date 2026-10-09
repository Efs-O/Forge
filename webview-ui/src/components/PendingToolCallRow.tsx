import React from 'react';
import type { PendingToolCall } from '../pendingToolCalls';

/**
 * A tool call the model is still writing, e.g.
 * `○ write_file matchbox.html · writing… 4,210 tokens`. It is replaced by the
 * real activity row the moment the call's arguments are complete.
 */
export function PendingToolCallRow({ call }: { call: PendingToolCall }): React.ReactElement {
  return (
    <div className="activity-row activity-pending" role="status">
      <div className="activity-row-header">
        <span className="tool-row-status is-pending" title="writing">
          ○
        </span>
        <span className="activity-row-name">{call.toolName}</span>
        {call.target && <span className="activity-row-detail">{call.target}</span>}
        <span className="activity-pending-progress">
          · writing… {call.tokens.toLocaleString('en-US')} tokens
        </span>
      </div>
    </div>
  );
}
