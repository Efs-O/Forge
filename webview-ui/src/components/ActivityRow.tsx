import React, { useEffect, useRef, useState } from 'react';
import type { AppMessage } from '../reducer';
import { displayDetail, stepMessages, stepThoughts, type ActivityStep } from '../activityRows';
import { formatDuration } from '../../../src/util/formatDuration';
import { sameRowList, toolNameAndDetail } from '../messageOps';
import {
  openedReasoning,
  readDisclosure,
  useDisclosure,
  writeDisclosure,
} from '../disclosureState';
import { DiffBlock, diffStats } from './DiffBlock';
import { ThinkingLabel, ThinkingRow } from './ThinkingGroup';
import { ToolRowThumbnails, ToolResultContent } from './ToolRow';

export interface ActivityRowProps {
  step: ActivityStep;
  streaming: boolean;
}

function finalAttempt(step: ActivityStep): AppMessage[] {
  return step.attempts.at(-1)?.tools ?? [];
}

/**
 * Whether a step renders open before this render's own choice is known: the
 * reader's choice for the step, else whether they opened reasoning that has
 * since folded into it. `ActivityGroup` asks the same question of its items.
 */
export function stepRevealed(step: ActivityStep): boolean {
  return readDisclosure('step', stepMessages(step)[0]!.id) ?? openedReasoning(stepThoughts(step));
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

function messageStatus(message: AppMessage): { glyph: string; className: string; label: string } {
  if (message.toolIsError) return { glyph: '✕', className: 'is-error', label: 'failed' };
  if (message.toolResultTotal !== undefined) {
    return { glyph: '✓', className: 'is-ok', label: 'completed' };
  }
  return { glyph: '○', className: 'is-pending', label: 'running' };
}

/**
 * The call's target. Without an extracted one, the content-derived detail is the
 * result label, and for a failure that is the error's first line, which the row
 * already prints under itself; showing it as the target put an argument name
 * such as "paths" where the paths belong.
 */
function callTarget(message: AppMessage): string {
  if (message.toolTarget !== undefined) return message.toolTarget;
  if (message.toolIsError) return message.toolDetail ?? '';
  return toolNameAndDetail(message).detail;
}

function firstErrorLine(message: AppMessage): string {
  return (message.toolResult ?? '').trim().split(/\r?\n/u, 1)[0] ?? '';
}

function AttemptLine({ message }: { message: AppMessage }): React.ReactElement {
  const state = messageStatus(message);
  const target = callTarget(message);
  const { name } = toolNameAndDetail(message);
  const elapsed = formatDuration(message.toolMs);
  const error = message.toolIsError ? firstErrorLine(message) : '';
  return (
    <div className={`activity-row-attempt ${message.toolIsError ? 'is-error' : ''}`}>
      <span className={`tool-row-status ${state.className}`} title={state.label}>
        {state.glyph}
      </span>
      <span className="activity-row-attempt-name">{message.toolName ?? name}</span>
      {target && (
        <span className="activity-row-attempt-target" title={target}>
          {displayDetail(target)}
        </span>
      )}
      {error && (
        <span className="activity-row-attempt-error" title={message.toolResult}>
          {error}
        </span>
      )}
      {elapsed && <span className="activity-row-attempt-time">{elapsed}</span>}
    </div>
  );
}

function DiffLink({
  ids,
  label,
  onOpenRow,
  onDiffChoiceChanged,
}: {
  ids: string[];
  label: React.ReactNode;
  onOpenRow: () => void;
  onDiffChoiceChanged: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="activity-row-diff-link"
      aria-label="Toggle file diff"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const show = !(readDisclosure('diff', ids[0]!) ?? false);
        for (const id of ids) writeDisclosure('diff', id, show);
        onOpenRow();
        onDiffChoiceChanged();
      }}
    >
      {label}
    </button>
  );
}

function ActivityRowView({ step }: ActivityRowProps): React.ReactElement | null {
  const [manualOpen, setManualOpen] = useDisclosure('step', stepMessages(step)[0]!.id);
  // An opened reasoning bubble also reveals its step when it folds into a call.
  const open = manualOpen ?? openedReasoning(stepThoughts(step));
  const [commandVisible, setCommandVisible] = useState(false);
  const [diffRevision, setDiffRevision] = useState(0);
  const targetRef = useRef<HTMLSpanElement>(null);
  const final = finalAttempt(step);
  const primary = final[0];
  const { name } = primary ? toolNameAndDetail(primary) : { name: '' };
  const target = primary ? callTarget(primary) : '';
  const displayedTarget = target ? displayDetail(target) : '';
  const command = primary?.toolDetail ?? target;
  const state = status(step);
  const failedEarlier = retryCount(step);
  // A step that ended red shows ✕ only; the amber chip means "recovered".
  const retries = state.className === 'is-error' ? 0 : failedEarlier;
  const repeated = failedEarlier === 0 && step.attempts.length > 1;
  const parallelCount = Math.max(...step.attempts.map((attempt) => attempt.tools.length));
  const edits = editSummary(step);
  const reasoning = reasoningSummary(step);
  const elapsed = formatDuration(primary?.toolMs);
  const tag =
    step.diffs.length === 0 ? '' : step.diffs.some((diff) => diff.diffIsNew) ? 'NEW' : 'MODIFIED';
  const rowTitle = [tag, elapsed].filter(Boolean).join(' · ');
  const failedMessage = final.find((message) => message.toolIsError);
  const errorLine = failedMessage ? firstErrorLine(failedMessage) : '';
  const hasCounts = edits.measured && (edits.added > 0 || edits.removed > 0);
  const diffLabel = hasCounts ? (
    <>
      {edits.added > 0 && <span className="diff-stat diff-stat-added">+{edits.added}</span>}
      {edits.removed > 0 && <span className="diff-stat diff-stat-removed">−{edits.removed}</span>}
    </>
  ) : (
    'diff'
  );

  useEffect(() => {
    if (!open) {
      setCommandVisible(false);
      return;
    }
    const targetElement = targetRef.current;
    setCommandVisible(
      Boolean(command && targetElement && targetElement.scrollWidth > targetElement.clientWidth),
    );
  }, [command, open]);

  if (!primary) return null;

  const toggle = (): void => setManualOpen(!open);
  const onHeaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <div className={`activity-row${state.className === 'is-error' ? ' is-error' : ''}`}>
      <div
        className="activity-row-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={rowTitle || undefined}
        onClick={toggle}
        onKeyDown={onHeaderKeyDown}
      >
        <span className="activity-row-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className={`tool-row-status ${state.className}`} title={state.label}>
          {state.glyph}
        </span>
        <span className="activity-row-name">{primary.toolName ?? name}</span>
        {parallelCount > 1 && (
          <span className="activity-row-parallel">+{parallelCount - 1} parallel</span>
        )}
        {displayedTarget && (
          <span ref={targetRef} className="activity-row-detail" title={target}>
            {displayedTarget}
          </span>
        )}
        <span className="activity-row-cluster">
          {tag && <span className="activity-row-tag">{tag}</span>}
          {step.diffs.length > 0 && (
            <DiffLink
              ids={step.diffs.map((diff) => diff.id)}
              label={diffLabel}
              onOpenRow={() => setManualOpen(true)}
              onDiffChoiceChanged={() => setDiffRevision((revision) => revision + 1)}
            />
          )}
          {reasoning && (
            <span className="activity-row-reasoning" title="Thinking">
              ◔
            </span>
          )}
          {repeated && <span className="activity-row-repeat">×{step.attempts.length}</span>}
          {retries > 0 && (
            <span className="activity-row-retry">
              {retries} {retries === 1 ? 'retry' : 'retries'}
            </span>
          )}
          {elapsed && <span className="activity-row-time">{elapsed}</span>}
        </span>
      </div>
      {errorLine && (
        <div className="activity-row-error-line" title={failedMessage?.toolResult}>
          {errorLine}
        </div>
      )}
      {!open &&
        final.map((message) => (
          <div key={message.id} className="activity-row-collapsed-thumbnails">
            <ToolRowThumbnails message={message} />
          </div>
        ))}
      {open && (
        <div className="activity-row-body">
          {step.attempts.map(({ thoughts, tools }, attemptIndex) => (
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
              {(step.attempts.length > 1 || tools.length > 1) && (
                <div className="activity-row-attempts" aria-label={`Attempt ${attemptIndex + 1}`}>
                  {tools.map((tool) => (
                    <AttemptLine key={tool.id} message={tool} />
                  ))}
                </div>
              )}
            </React.Fragment>
          ))}
          {final.map((message) => (
            <React.Fragment key={`output-${message.id}`}>
              <ToolResultContent
                message={message}
                folded
                {...(commandVisible && message.id === primary.id && command ? { command } : {})}
              />
              <ToolRowThumbnails message={message} />
            </React.Fragment>
          ))}
          {step.diffs.map((diff) => (
            <DiffBlock
              key={`${diff.id}-${diffRevision}`}
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
