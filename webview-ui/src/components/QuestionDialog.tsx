import React, { useCallback, useEffect, useRef } from 'react';
import type { StructuredAnswer } from '../../../src/util/questionAnswers';
import { isAnswered, togglePick } from '../../../src/util/questionPicks';
import type { AgentQuestion, QuestionDraft } from '../useAgentDialogs';
import { QuestionBody } from './QuestionBody';
import { QuestionReview } from './QuestionReview';

interface Props {
  question: AgentQuestion;
  draft: QuestionDraft;
  autoFocus: boolean;
  onDraftChange: (draft: QuestionDraft) => void;
  onAnswer: (answer: StructuredAnswer) => void;
  onSkip: () => void;
}

function tabLabel(header: string | undefined, prompt: string, index: number): string {
  const label = (header || prompt || `Question ${index + 1}`).trim();
  return label.length > 22 ? `${label.slice(0, 21)}…` : label;
}

export function QuestionDialog({
  question,
  draft,
  autoFocus,
  onDraftChange,
  onAnswer,
  onSkip,
}: Props): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const specs = question.specs;
  const hasTabs = specs.length > 1;
  const reviewTab = specs.length;
  const tab = Math.max(0, Math.min(draft.tab, hasTabs ? reviewTab : 0));
  const answeredCount = specs.reduce(
    (count, _spec, index) =>
      count + (isAnswered(draft.picks[index] ?? [], draft.notes[index]) ? 1 : 0),
    0,
  );
  const allAnswered = answeredCount === specs.length;

  useEffect(() => {
    if (autoFocus) panelRef.current?.focus();
  }, [autoFocus, question.id]);

  const updateTab = useCallback(
    (nextTab: number) => onDraftChange({ ...draft, tab: nextTab }),
    [draft, onDraftChange],
  );

  const answer = useCallback(() => {
    if (!allAnswered) return;
    const result: StructuredAnswer = {
      answers: specs.map((_spec, index) => {
        const note = draft.notes[index] ?? '';
        return {
          picks: [...(draft.picks[index] ?? [])],
          ...(note.trim() ? { note } : {}),
        };
      }),
    };
    onAnswer(result);
  }, [allAnswered, draft, onAnswer, specs]);

  const primaryAction = useCallback(() => {
    if (!hasTabs || tab === reviewTab) answer();
    else updateTab(tab + 1);
  }, [answer, hasTabs, reviewTab, tab, updateTab]);

  const toggleOption = useCallback(
    (optionIndex: number) => {
      const spec = specs[tab];
      if (!spec) return;
      const picks = togglePick(spec, draft.picks[tab] ?? [], optionIndex);
      onDraftChange({
        ...draft,
        picks: draft.picks.map((current, index) => (index === tab ? picks : current)),
      });
    },
    [draft, onDraftChange, specs, tab],
  );

  const onPanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (target instanceof HTMLTextAreaElement) {
          target.blur();
          panelRef.current?.focus();
        }
        return;
      }
      if (
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        target instanceof HTMLElement &&
        target.closest('[role="tablist"]')
      ) {
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const count = specs.length + 1;
        const nextTab = (tab + delta + count) % count;
        updateTab(nextTab);
        panelRef.current
          ?.querySelector<HTMLButtonElement>(`[data-question-tab="${nextTab}"]`)
          ?.focus();
        return;
      }
      if (event.key === 'Enter' && target instanceof HTMLTextAreaElement) {
        if (event.shiftKey) return;
        event.preventDefault();
        primaryAction();
        return;
      }
      if (event.key === 'Enter' && !(target instanceof HTMLButtonElement)) {
        event.preventDefault();
        primaryAction();
        return;
      }
      if (tab >= specs.length || !/^[1-9]$/u.test(event.key)) return;
      if (
        target instanceof HTMLElement &&
        target.closest('textarea, input, [contenteditable="true"]')
      ) {
        return;
      }
      const optionIndex = Number(event.key) - 1;
      if (!specs[tab]?.options[optionIndex]) return;
      event.preventDefault();
      toggleOption(optionIndex);
    },
    [primaryAction, specs, tab, toggleOption, updateTab],
  );

  const currentSpec = tab < specs.length ? specs[tab] : undefined;
  // With several questions the top-level prompt is their shared preamble; with
  // one it is that question's own prompt, already shown in the body.
  const preamble = specs.some((spec) => spec.prompt.trim() === question.prompt.trim())
    ? ''
    : question.prompt.trim();
  const showAnswer = !hasTabs || tab === reviewTab;
  const primaryLabel = showAnswer ? 'Answer' : 'Next';
  const primaryDisabled = showAnswer && !allAnswered;

  return (
    <div
      ref={panelRef}
      className="docked-dialog-panel question-docked-panel"
      role="dialog"
      aria-labelledby="question-dialog-title"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
    >
      <section className="question-card">
        <header className="question-card-header">
          <div className="question-card-title">
            <span id="question-dialog-title">Forge asks</span>
            <span className="question-progress">
              {answeredCount} of {specs.length} answered
            </span>
          </div>
          <span className="question-card-mark" aria-hidden="true">
            ?
          </span>
        </header>

        {hasTabs && preamble && <p className="question-preamble">{preamble}</p>}

        {hasTabs && (
          <div className="question-tabs" role="tablist" aria-label="Question steps">
            {specs.map((spec, index) => {
              const complete = isAnswered(draft.picks[index] ?? [], draft.notes[index]);
              return (
                <button
                  key={`${index}-${spec.header ?? spec.prompt}`}
                  id={`question-tab-${index}`}
                  data-question-tab={index}
                  type="button"
                  role="tab"
                  aria-selected={tab === index}
                  aria-controls="question-panel-content"
                  className={`question-tab${tab === index ? ' is-active' : ''}`}
                  onClick={() => updateTab(index)}
                >
                  {complete && (
                    <span className="question-tab-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                  {tabLabel(spec.header, spec.prompt, index)}
                </button>
              );
            })}
            <button
              id="question-tab-review"
              data-question-tab={reviewTab}
              type="button"
              role="tab"
              aria-selected={tab === reviewTab}
              aria-controls="question-panel-content"
              className={`question-tab${tab === reviewTab ? ' is-active' : ''}`}
              onClick={() => updateTab(reviewTab)}
            >
              Review
            </button>
          </div>
        )}

        <div id="question-panel-content" className="question-card-content">
          {currentSpec ? (
            <QuestionBody
              key={tab}
              spec={currentSpec}
              questionIndex={tab}
              picks={draft.picks[tab] ?? []}
              note={draft.notes[tab] ?? ''}
              placeholder={question.placeholder}
              onToggle={toggleOption}
              onNoteChange={(note) =>
                onDraftChange({
                  ...draft,
                  notes: draft.notes.map((current, index) => (index === tab ? note : current)),
                })
              }
            />
          ) : (
            <QuestionReview
              specs={specs}
              picks={draft.picks}
              notes={draft.notes}
              onJump={updateTab}
            />
          )}
        </div>

        <footer className="question-footer">
          <span className="question-key-hint">
            1–9 to choose · Enter {showAnswer ? 'to send' : 'for next'}
          </span>
          <div className="question-actions">
            <button className="question-skip" type="button" onClick={onSkip}>
              Skip
            </button>
            <button
              className="question-answer"
              type="button"
              disabled={primaryDisabled}
              onClick={primaryAction}
            >
              {primaryLabel}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
