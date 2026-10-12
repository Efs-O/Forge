import React from 'react';
import { readDisclosure, useDisclosure } from '../disclosureState';
import type { ActivityGroupItem } from '../activityRows';
import { displayDetail, groupMessages, stepMessages } from '../activityRows';
import { sameRowList, toolNameAndDetail } from '../messageOps';
import { summarizeGroup } from '../activityGroups';
import { ActivityRow } from './ActivityRow';
import { ThinkingGroup } from './ThinkingGroup';
import type { PendingToolCall } from '../pendingToolCalls';

export interface ActivityGroupProps {
  items: ActivityGroupItem[];
  /** This group holds the last message and its conversation is streaming. */
  live: boolean;
  /** The conversation is streaming (passed through to each `ActivityRow`). */
  streaming: boolean;
  /** Calls whose arguments are still streaming, before a transcript row exists. */
  pendingCalls?: readonly PendingToolCall[];
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

function ActivityGroupView({
  items,
  live,
  streaming,
  pendingCalls = [],
}: ActivityGroupProps): React.ReactElement {
  const firstId =
    groupMessages(items)[0]?.id ??
    pendingCalls[0]?.toolCallId ??
    `pending-${pendingCalls[0]?.index ?? 0}`;
  const [choice, setChoice] = useDisclosure('group', firstId);
  const summary = summarizeGroup(items);
  const openedStep = items.some(
    (item) =>
      item.kind === 'step' && readDisclosure('step', stepMessages(item.step)[0]!.id) === true,
  );
  const expanded = choice ?? openedStep;
  const status = summary.failed > 0 ? '✕' : summary.pending ? '○' : '✓';
  const recordedTools = live
    ? items.flatMap((item) =>
        item.kind === 'step' ? item.step.attempts.flatMap((attempt) => attempt.tools) : [],
      )
    : [];
  const recorded =
    recordedTools
      .filter((tool) => tool.toolResultTotal === undefined && !tool.toolIsError)
      .at(-1) ?? recordedTools.at(-1);
  const writing = pendingCalls.at(-1);
  const recordedLabel = recorded ? toolNameAndDetail(recorded) : undefined;
  const activeCount = summary.toolCalls + pendingCalls.length;
  const activeName = writing
    ? pendingCalls.length > 1
      ? `${pendingCalls.length} calls running`
      : writing.toolName
    : recordedLabel?.name;
  const activeTarget = displayDetail(
    writing?.target ?? recorded?.toolTarget ?? recordedLabel?.detail ?? '',
  );
  const activePending = Boolean(
    writing || (recorded && recorded.toolResultTotal === undefined && !recorded.toolIsError),
  );
  const activeFailed = Boolean(!writing && recorded?.toolIsError);

  return (
    <section className={`activity-group${expanded ? ' activity-group-open' : ''}`}>
      <button
        className={`activity-group-toggle${summary.failed > 0 ? ' has-failure' : ''}`}
        type="button"
        disabled={items.length === 0}
        onClick={() => setChoice(!expanded)}
        aria-expanded={expanded}
      >
        <span className="activity-group-chevron">
          {items.length > 0 && <Chevron expanded={expanded} />}
        </span>
        <span
          className={`activity-group-status${summary.failed > 0 ? ' is-failed' : live ? ' is-live' : ''}`}
        >
          {live && summary.failed === 0 ? '●' : status}
        </span>
        <span className="activity-group-label">
          {live ? (
            'Working'
          ) : (
            <>
              <span className="activity-group-count">{summary.toolCalls}</span>{' '}
              <span className="activity-group-word">
                tool {summary.toolCalls === 1 ? 'call' : 'calls'}
              </span>
            </>
          )}
          {live && (
            <>
              {' · '}
              <span className="activity-group-count">{activeCount}</span>{' '}
              <span className="activity-group-word">{activeCount === 1 ? 'call' : 'calls'}</span>
            </>
          )}
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
        {items.length > 0 && (
          <span className="activity-group-details">{expanded ? 'Hide details' : 'Details'}</span>
        )}
      </button>
      {!expanded && live && activeName && (
        <div className="activity-group-pending" role="status">
          <span
            className={`tool-row-status ${activePending ? 'is-pending' : activeFailed ? 'is-error' : 'is-ok'}`}
          >
            {activePending ? '○' : activeFailed ? '✕' : '✓'}
          </span>
          {pendingCalls.length > 1 ? (
            <>
              <span className="activity-group-pending-count">{pendingCalls.length}</span>{' '}
              <span className="activity-group-pending-name">calls</span>{' '}
              <span className="activity-group-pending-meta">running</span>
            </>
          ) : (
            <span className="activity-group-pending-name">{activeName}</span>
          )}
          {pendingCalls.length <= 1 && activeTarget && (
            <span className="activity-group-pending-target" title={activeTarget}>
              {activeTarget}
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
    a.pendingCalls === b.pendingCalls &&
    sameRowList(groupMessages(a.items), groupMessages(b.items)),
);
