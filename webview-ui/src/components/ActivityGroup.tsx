import React from 'react';
import { useDisclosure } from '../disclosureState';
import type { ActivityGroupItem } from '../activityRows';
import { groupMessages, stepMessages } from '../activityRows';
import { sameRowList } from '../messageOps';
import { summarizeGroup } from '../activityGroups';
import { foldRuns, type FoldedItem } from '../activityRuns';
import { ActivityRow } from './ActivityRow';
import { ActivityRunRow } from './ActivityRunRow';
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

function itemKey(item: FoldedItem): string {
  if (item.kind === 'step') return stepMessages(item.step)[0]!.id;
  if (item.kind === 'run') return stepMessages(item.steps[0]!)[0]!.id;
  return item.steps[0]!.id;
}

function ActivityGroupView({ items, live, streaming }: ActivityGroupProps): React.ReactElement {
  const [manualExpanded, setManualExpanded] = useDisclosure('group', groupMessages(items)[0]!.id);
  const summary = summarizeGroup(items);
  const expanded = manualExpanded ?? true;
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
                {summary.added > 0 && (
                  <>
                    {' '}
                    <span className="diff-stat diff-stat-added">+{summary.added}</span>
                  </>
                )}
                {summary.removed > 0 && (
                  <>
                    {' '}
                    <span className="diff-stat diff-stat-removed">−{summary.removed}</span>
                  </>
                )}
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
          <span className="activity-group-retry">
            [{summary.retries} {summary.retries === 1 ? 'retry' : 'retries'}]
          </span>
        )}
      </button>
      {expanded && (
        <div className="activity-group-body">
          {foldRuns(items).map((item) =>
            item.kind === 'step' ? (
              <ActivityRow key={itemKey(item)} step={item.step} streaming={streaming} />
            ) : item.kind === 'run' ? (
              <ActivityRunRow
                key={itemKey(item)}
                toolName={item.toolName}
                steps={item.steps}
                streaming={streaming}
              />
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
