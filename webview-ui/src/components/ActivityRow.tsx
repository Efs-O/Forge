import React from 'react';
import type { AppMessage } from '../reducer';
import {
  displayDetail,
  stepMessages,
  stepThoughts,
  stepTools,
  type ActivityStep,
} from '../activityRows';
import { formatDuration } from '../../../src/util/formatDuration';
import { sameRowList, toolNameAndDetail } from '../messageOps';
import { readDisclosure, useDisclosure } from '../disclosureState';
import { DiffBlock, diffStats } from './DiffBlock';
import { ThinkingLabel, ThinkingRow } from './ThinkingGroup';
import { ToolGroup } from './ToolGroup';
import { ToolRow, ToolRowThumbnails } from './ToolRow';

export interface ActivityRowProps {
  step: ActivityStep;
  streaming: boolean;
}

const Chevron = ({ open }: { open: boolean }): React.ReactElement => (
  <span className="activity-row-chevron" aria-hidden="true">
    {open ? '▾' : '▸'}
  </span>
);

function finalAttempt(step: ActivityStep): AppMessage[] {
  return step.attempts.at(-1)?.tools ?? [];
}

function openedThought(step: ActivityStep): boolean {
  const thoughts = stepThoughts(step);
  if (thoughts[0] && readDisclosure('thinkingGroup', thoughts[0].id)) return true;
  return thoughts.some((thought) => readDisclosure('thinking', thought.id) === true);
}

function hasPendingCall(step: ActivityStep): boolean {
  return stepTools(step).some(
    (message) => message.toolResultTotal === undefined && !message.toolIsError,
  );
}

function isFailure(attempt: AppMessage[]): boolean {
  return attempt.some((message) => message.toolIsError);
}

function status(step: ActivityStep): { glyph: string; className: string; label: string } {
  const last = finalAttempt(step);
  if (last.some((message) => message.toolResultTotal === undefined && !message.toolIsError)) {
    return { glyph: '○', className: 'is-pending', label: 'running' };
  }
  if (isFailure(last)) return { glyph: '✕', className: 'is-error', label: 'failed' };
  return { glyph: '✓', className: 'is-ok', label: 'completed' };
}

function retryCount(step: ActivityStep): number {
  return step.attempts.slice(0, -1).filter((attempt) => isFailure(attempt.tools)).length;
}

function reasoningSummary(step: ActivityStep): string | undefined {
  const thoughts = stepThoughts(step);
  if (thoughts.length === 0) return undefined;
  const measured = thoughts.filter((thought) => thought.reasoningMs !== undefined);
  if (measured.length === 0) return '◔';
  const elapsed = formatDuration(
    measured.reduce((total, thought) => total + thought.reasoningMs!, 0),
  );
  return elapsed ? `◔ ${elapsed}` : '◔';
}

function editSummary(step: ActivityStep): { added: number; removed: number; measured: boolean } {
  return step.diffs.reduce<{ added: number; removed: number; measured: boolean }>(
    (total, diff) => {
      if (diff.diffHunks === null || diff.diffHunks === undefined) return total;
      const counts = diffStats(diff.diffHunks);
      return {
        added: total.added + counts.added,
        removed: total.removed + counts.removed,
        measured: true,
      };
    },
    { added: 0, removed: 0, measured: false },
  );
}

function ActivityRowView({ step, streaming }: ActivityRowProps): React.ReactElement | null {
  const [manualOpen, setManualOpen] = useDisclosure('step', stepMessages(step)[0]!.id);
  // The reader's own toggle wins. Otherwise a running call forces the step
  // open, and so does a reasoning bubble the reader opened before it folded
  // into this step (it was a standalone thinking row until the call arrived).
  const open = manualOpen ?? ((streaming && hasPendingCall(step)) || openedThought(step));
  const final = finalAttempt(step);
  const primary = final[0];
  if (!primary) return null;

  const { name, detail } = toolNameAndDetail(primary);
  const target = primary.toolTarget ?? detail;
  const displayedTarget = target ? displayDetail(target) : '';
  const state = status(step);
  const failedEarlier = retryCount(step);
  // A step that ended red shows ✕ only; the amber chip means "recovered".
  const retries = state.className === 'is-error' ? 0 : failedEarlier;
  const edits = editSummary(step);
  const reasoning = reasoningSummary(step);

  return (
    <div className={`activity-row${state.className === 'is-error' ? ' is-error' : ''}`}>
      <button
        type="button"
        className="activity-row-header"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
      >
        <Chevron open={open} />
        <span className={`tool-row-status ${state.className}`} title={state.label}>
          {state.glyph}
        </span>
        {step.diffs.length > 0 && (
          <span className="activity-row-edit" title="File changes">
            ✎
            {edits.measured && edits.added > 0 && (
              <>
                {' '}
                <span className="diff-stat diff-stat-added">+{edits.added}</span>
              </>
            )}
            {edits.measured && edits.removed > 0 && (
              <>
                {' '}
                <span className="diff-stat diff-stat-removed">−{edits.removed}</span>
              </>
            )}
          </span>
        )}
        <span className="activity-row-name">{primary.toolName ?? name}</span>
        {displayedTarget && <span className="activity-row-detail">{displayedTarget}</span>}
        {step.attempts.length > 1 && failedEarlier === 0 && (
          <span className="activity-row-repeat">×{step.attempts.length}</span>
        )}
        {retries > 0 && (
          <span className="activity-row-retry">
            {retries} {retries === 1 ? 'retry' : 'retries'}
          </span>
        )}
        {reasoning && <span className="activity-row-reasoning">{reasoning}</span>}
      </button>
      {!open &&
        final.map((message) => (
          <div key={message.id} className="activity-row-collapsed-thumbnails">
            <ToolRowThumbnails message={message} />
          </div>
        ))}
      {open && (
        <div className="activity-row-body">
          {step.attempts.map(({ thoughts, tools }) => (
            <React.Fragment key={tools[0]!.id}>
              {thoughts.map((thought) => (
                <ThinkingRow
                  key={thought.id}
                  id={thought.id}
                  label={
                    <ThinkingLabel
                      startedAt={thought.reasoningStartedAt}
                      ms={thought.reasoningMs}
                    />
                  }
                  reasoning={thought.reasoning ?? ''}
                />
              ))}
              {tools.length > 1 ? (
                <ToolGroup tools={tools} />
              ) : (
                <ToolRow message={tools[0]!} nested />
              )}
            </React.Fragment>
          ))}
          {step.diffs.map((diff) => (
            <DiffBlock
              key={diff.id}
              id={diff.id}
              filePath={diff.content}
              hunks={diff.diffHunks}
              isNew={diff.diffIsNew}
              isDeleted={diff.diffIsDeleted}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const ActivityRow = React.memo(
  ActivityRowView,
  (previous, next) =>
    previous.streaming === next.streaming &&
    sameRowList(stepMessages(previous.step), stepMessages(next.step)),
);
