import React from 'react';
import type { PendingToolCall } from '../pendingToolCalls';
import { useSecondsSince } from '../useSecondsSince';

/**
 * Below this the count is only the call's opening `{`. A server may hold a
 * non-string argument until it is complete (Strata does, for `edit_file`'s
 * `edits` array), so the count can sit there for minutes; the timer still says
 * the call is being written.
 */
const MIN_SHOWN_TOKENS = 2;

/** `writing… 42 s · 4,210 tokens`; the count only once there is one to show. */
export function pendingProgressLabel(seconds: number, tokens: number): string {
  const time = `writing… ${seconds} s`;
  if (tokens < MIN_SHOWN_TOKENS) return time;
  return `${time} · ${tokens.toLocaleString('en-US')} tokens`;
}

/**
 * A tool call the model is still writing, e.g.
 * `○ write_file matchbox.html · writing… 42 s · 4,210 tokens`. It is replaced
 * by the real activity row the moment the call's arguments are complete.
 */
export function PendingToolCallRow({ call }: { call: PendingToolCall }): React.ReactElement {
  const seconds = useSecondsSince(call.startedAt, true);
  return (
    <div className="activity-row activity-pending" role="status">
      <div className="activity-row-header">
        <span className="tool-row-status is-pending" title="writing">
          ○
        </span>
        <span className="activity-row-name">{call.toolName}</span>
        {call.target && <span className="activity-row-detail">{call.target}</span>}
        <span className="activity-pending-progress">
          · {pendingProgressLabel(seconds, call.tokens)}
        </span>
      </div>
    </div>
  );
}
