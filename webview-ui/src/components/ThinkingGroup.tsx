import React from 'react';
import type { ThinkingDisplayMode } from '../../../src/sidebar/activityViewSetting';
import { formatDuration } from '../../../src/util/formatDuration';
import { sameRowList } from '../messageOps';
import { useFoldChoice } from '../disclosureState';
import { FoldedContent, isLongThinking } from './FoldedContent';
import type { AppMessage } from '../reducer';

function ThinkingBlock({
  step,
  displayMode,
  streaming,
}: {
  step: AppMessage;
  displayMode: ThinkingDisplayMode;
  streaming: boolean;
}): React.ReactElement {
  const reasoning = step.reasoning ?? '';
  const storageId = `thinking:${step.id}`;
  const [choice, setChoice] = useFoldChoice(storageId);
  const live = streaming && step.reasoningStartedAt !== undefined && step.reasoningMs === undefined;
  const long = isLongThinking(reasoning);
  const collapsed = choice.collapsed ?? displayMode === 'collapsed';
  const foldable = displayMode === 'preview' && !live && long;
  const defaultShowAll = displayMode !== 'preview' || live || !long;
  const duration = formatDuration(step.reasoningMs);

  return (
    <section className="thinking-block" aria-label="Model thinking" data-thinking-id={step.id}>
      <header className="thinking-block-header">
        <span className="thinking-block-title">
          {live ? (
            <>
              Thinking…{' '}
              <span className="thinking-pulse" aria-hidden="true">
                ●
              </span>
            </>
          ) : (
            <>◔ Thinking{duration ? ` · ${duration}` : ''}</>
          )}
        </span>
        <button
          type="button"
          className="thinking-block-collapse"
          aria-expanded={!collapsed}
          onClick={() => setChoice({ collapsed: !collapsed })}
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </header>
      {!collapsed && (
        <FoldedContent
          id={`${storageId}:body`}
          content={reasoning}
          foldable={foldable}
          defaultShowAll={defaultShowAll}
          className="thinking-block-content"
        />
      )}
    </section>
  );
}

interface Props {
  /** Adjacent reasoning messages, each rendered as its own top-level block. */
  steps: AppMessage[];
  displayMode: ThinkingDisplayMode;
  streaming: boolean;
}

function ThinkingGroupView({ steps, displayMode, streaming }: Props): React.ReactElement | null {
  if (steps.length === 0) return null;
  return (
    <>
      {steps.map((step) => (
        <ThinkingBlock key={step.id} step={step} displayMode={displayMode} streaming={streaming} />
      ))}
    </>
  );
}

export const ThinkingGroup = React.memo(
  ThinkingGroupView,
  (a, b) =>
    a.displayMode === b.displayMode &&
    a.streaming === b.streaming &&
    sameRowList(a.steps, b.steps) &&
    a.steps.every(
      (step, index) =>
        step.reasoningMs === b.steps[index]?.reasoningMs &&
        step.reasoningStartedAt === b.steps[index]?.reasoningStartedAt,
    ),
);
