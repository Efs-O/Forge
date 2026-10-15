import React from 'react';
import { openedReasoning, readDisclosure, useDisclosure } from '../disclosureState';
import type { ActivityGroupItem } from '../activityRows';
import { displayDetail, groupMessages, stepMessages } from '../activityRows';
import { sameRowList, toolNameAndDetail } from '../messageOps';
import {
  recoveredFailures,
  summarizeGroup,
  visibleGroupItems,
  type GroupGap,
  type VisibleGroupItem,
} from '../activityGroups';
import { ActivityRow, stepRevealed } from './ActivityRow';
import { ThinkingGroup } from './ThinkingGroup';
import type { PendingToolCall } from '../pendingToolCalls';
import { groupImages } from '../toolImages';
import { GroupImageStrip } from './ToolThumbnails';

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

function GroupGapButton({
  groupId,
  gap,
  onReveal,
}: {
  groupId: string;
  gap: GroupGap;
  onReveal: () => void;
}): React.ReactElement {
  const [, remember] = useDisclosure('gap', `${groupId}:${gap.firstStepId}`);
  return (
    <button
      className="activity-group-gap"
      type="button"
      onClick={() => {
        remember(true);
        onReveal();
      }}
    >
      {gap.leading ? '▴' : '⋯'} Show {gap.calls} {gap.leading ? 'earlier' : 'more'}{' '}
      {gap.calls === 1 ? 'call' : 'calls'}
    </button>
  );
}

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
  const [, refreshGaps] = React.useState(0);
  const summary = summarizeGroup(items);
  const recovered = recoveredFailures(items);
  const unrecovered = Math.max(0, summary.failed - recovered.size);
  const opened = new Set(
    items.flatMap((item) =>
      item.kind === 'step' && stepRevealed(item.step) ? [stepMessages(item.step)[0]!.id] : [],
    ),
  );
  const initialItems = visibleGroupItems(items, recovered, new Set(), opened);
  const revealed = new Set(
    initialItems.flatMap((item) =>
      item.kind === 'gap' && readDisclosure('gap', `${firstId}:${item.firstStepId}`) === true
        ? [item.firstStepId]
        : [],
    ),
  );
  const visibleItems = visibleGroupItems(items, recovered, revealed, opened);
  const imageCount = groupImages(items).length;
  // An opened step, or an opened reasoning bubble that folded into this group
  // (inside a step or as a reasoning run), keeps the group open on remount.
  const openedItem = items.some((item) =>
    item.kind === 'step' ? stepRevealed(item.step) : openedReasoning(item.steps),
  );
  const expanded = choice ?? openedItem;
  const status = unrecovered > 0 ? '✕' : summary.pending ? '○' : '✓';
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
        className={`activity-group-toggle${unrecovered > 0 ? ' has-failure' : ''}`}
        type="button"
        disabled={items.length === 0}
        onClick={() => setChoice(!expanded)}
        aria-expanded={expanded}
      >
        <span className="activity-group-chevron">
          {items.length > 0 && <Chevron expanded={expanded} />}
        </span>
        <span
          className={`activity-group-status${unrecovered > 0 ? ' is-failed' : live ? ' is-live' : ''}`}
        >
          {live && unrecovered === 0 ? '●' : status}
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
        {summary.failed > 0 && (
          <span className={`activity-group-failed${unrecovered === 0 ? ' is-recovered' : ''}`}>
            {unrecovered > 0 ? `${unrecovered} failed` : `${summary.failed} failed, recovered`}
          </span>
        )}
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
        {imageCount > 0 && (
          <span className="activity-group-images">
            · {imageCount} {imageCount === 1 ? 'image' : 'images'}
          </span>
        )}
        {summary.retries > 0 && (
          <span className="activity-group-retry">
            [{summary.retries} {summary.retries === 1 ? 'retry' : 'retries'}]
          </span>
        )}
      </button>
      {!expanded && <GroupImageStrip items={items} onMore={() => setChoice(true)} />}
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
          {visibleItems.map((item: VisibleGroupItem) => {
            if (item.kind === 'gap') {
              return (
                <GroupGapButton
                  key={`gap-${item.firstStepId}`}
                  groupId={firstId}
                  gap={item}
                  onReveal={() => refreshGaps((version) => version + 1)}
                />
              );
            }
            return item.kind === 'step' ? (
              <ActivityRow key={itemKey(item)} step={item.step} streaming={streaming} />
            ) : (
              <ThinkingGroup key={itemKey(item)} steps={item.steps} />
            );
          })}
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
