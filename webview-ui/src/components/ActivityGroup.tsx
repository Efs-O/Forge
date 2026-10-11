import React from 'react';
import { readDisclosure, useDisclosure } from '../disclosureState';
import type { ActivityGroupItem } from '../activityRows';
import { displayDetail, groupMessages, stepMessages } from '../activityRows';
import { sameRowList, toolNameAndDetail } from '../messageOps';
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
  if (item.kind === 'step') return stepMessages(item.step)[0]!.id;
  return item.steps[0]!.id;
}

function ActivityGroupView({ items, live, streaming }: ActivityGroupProps): React.ReactElement {
  const [choice, setChoice] = useDisclosure('group', groupMessages(items)[0]!.id);
  const summary = summarizeGroup(items);
  const openedStep = items.some(
    (item) =>
      item.kind === 'step' && readDisclosure('step', stepMessages(item.step)[0]!.id) === true,
  );
  const expanded = choice ?? openedStep;
  const status = summary.failed > 0 ? '✕' : summary.pending ? '○' : '✓';
  const pendingTools = live
    ? items.flatMap((item) =>
        item.kind === 'step'
          ? item.step.attempts
              .flatMap((attempt) => attempt.tools)
              .filter((tool) => tool.toolResultTotal === undefined && !tool.toolIsError)
          : [],
      )
    : [];
  const pending = pendingTools.at(-1);
  const pendingLabel = pending ? toolNameAndDetail(pending) : undefined;
  const pendingTarget = pending
    ? displayDetail(pending.toolTarget ?? pendingLabel?.detail ?? '')
    : '';

  return (
    <section className={`activity-group${expanded ? ' activity-group-open' : ''}`}>
      <button
        className={`activity-group-toggle${summary.failed > 0 ? ' has-failure' : ''}`}
        type="button"
        onClick={() => setChoice(!expanded)}
        aria-expanded={expanded}
      >
        <span className="activity-group-chevron">
          <Chevron expanded={expanded} />
        </span>
        <span
          className={`activity-group-status${summary.failed > 0 ? ' is-failed' : live ? ' is-live' : ''}`}
        >
          {live && summary.failed === 0 ? '●' : status}
        </span>
        <span className="activity-group-label">
          {live
            ? 'Working'
            : `${summary.toolCalls} tool ${summary.toolCalls === 1 ? 'call' : 'calls'}`}
          {live && ` · ${summary.toolCalls} ${summary.toolCalls === 1 ? 'call' : 'calls'}`}
        </span>
        {summary.editCount > 0 && (
          <>
            <span className="activity-group-edit-stats">
              · ✎ {summary.editCount}
              {summary.added > 0 && (
                <span className="diff-stat diff-stat-added"> +{summary.added}</span>
              )}
              {summary.removed > 0 && (
                <span className="diff-stat diff-stat-removed"> −{summary.removed}</span>
              )}
            </span>
            <span className="activity-group-edits">{summary.fileLabel}</span>
          </>
        )}
        {!live && summary.hasThinking && (
          <span className="activity-group-thinking">
            · ◔{summary.thinking ? ` ${summary.thinking}` : ''} thinking
          </span>
        )}
        {summary.failed > 0 && (
          <span className="activity-group-failed">[{summary.failed} failed]</span>
        )}
        {summary.retries > 0 && (
          <span className="activity-group-retry">
            [{summary.retries} {summary.retries === 1 ? 'retry' : 'retries'}]
          </span>
        )}
        <span className="activity-group-details">{expanded ? 'Hide details' : 'Details'}</span>
      </button>
      {!expanded && pending && (
        <div className="activity-group-pending" role="status">
          <span className="tool-row-status is-pending">○</span>
          <span className="activity-group-pending-name">
            {pendingTools.length > 1 ? `${pendingTools.length} calls running` : pendingLabel?.name}
          </span>
          {pendingTools.length === 1 && pendingTarget && (
            <span className="activity-group-pending-target" title={pendingTarget}>
              {pendingTarget}
            </span>
          )}
        </div>
      )}
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
