import React, { useState } from 'react';
import type { ActivityGroupItem } from '../activityRows';
import { groupMessages, stepMessages } from '../activityRows';
import { sameRowList } from '../messageOps';
import { summarizeGroup } from '../activityGroups';
import { ActivityRow } from './ActivityRow';
import { ThinkingGroup } from './ThinkingGroup';

export interface ActivityGroupProps {
  items: ActivityGroupItem[];
  /** This group holds the last message and its conversation is streaming. */
  live: boolean;
  /** The conversation is streaming (passed through to each `ActivityRow`). */
  streaming: boolean;
}

const Chevron = ({ expanded }: { expanded: boolean }): React.ReactElement => (
  <svg
    width={expanded ? '10' : '6'}
    height={expanded ? '6' : '10'}
    viewBox={expanded ? '0 0 10 6' : '0 0 6 10'}
    fill="currentColor"
    aria-hidden="true"
  >
    <path d={expanded ? 'M0 0l5 6 5-6z' : 'M0 0l6 5-6 5z'} />
  </svg>
);

function itemKey(item: ActivityGroupItem): string {
  return item.kind === 'step' ? stepMessages(item.step)[0]!.id : item.steps[0]!.id;
}

function ActivityGroupView({ items, live, streaming }: ActivityGroupProps): React.ReactElement {
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const summary = summarizeGroup(items);
  const expanded = manualExpanded ?? (live || (streaming && summary.pending) || summary.failed > 0);
  const status = summary.failed > 0 ? '✕' : streaming && summary.pending ? '○' : '✓';

  return (
    <section className={`activity-group${expanded ? ' activity-group-open' : ''}`}>
      <button
        className={`activity-group-toggle${summary.failed > 0 ? ' has-failure' : ''}`}
        type="button"
        onClick={() => setManualExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="activity-group-chevron">
          <Chevron expanded={expanded} />
        </span>
        {live ? (
          <span className={`activity-group-live${summary.failed > 0 ? ' has-failure' : ''}`}>
            ● working · {summary.toolCalls} calls
          </span>
        ) : (
          <>
            <span className={`activity-group-status${summary.failed > 0 ? ' is-failed' : ''}`}>
              {status}
            </span>
            <span>{summary.toolCalls} tool calls</span>
            {summary.editCount > 0 && (
              <span className="activity-group-edits">
                · ✎ {summary.editCount} edits {summary.fileLabel}
                {(summary.added > 0 || summary.removed > 0) &&
                  ` +${summary.added} −${summary.removed}`}
              </span>
            )}
            {summary.hasThinking && (
              <span className="activity-group-thinking">
                · ◔{summary.thinking ? ` ${summary.thinking}` : ''} thinking
              </span>
            )}
          </>
        )}
        {summary.failed > 0 && (
          <span className="activity-group-failed">[{summary.failed} failed]</span>
        )}
        {summary.retries > 0 && (
          <span className="activity-group-retry">[{summary.retries} retry]</span>
        )}
      </button>
      {expanded && (
        <div className="activity-group-body">
          {items.map((item) =>
            item.kind === 'step' ? (
              <ActivityRow key={itemKey(item)} step={item.step} streaming={streaming} />
            ) : (
              <ThinkingGroup key={itemKey(item)} steps={item.steps} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** Compare transcript contents, plus the state that changes the header/body. */
export const ActivityGroup = React.memo(
  ActivityGroupView,
  (a, b) =>
    a.live === b.live &&
    a.streaming === b.streaming &&
    sameRowList(groupMessages(a.items), groupMessages(b.items)),
);
