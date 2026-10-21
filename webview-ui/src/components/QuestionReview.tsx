import React from 'react';
import { formatStructuredAnswer, type QuestionSpec } from '../../../src/util/questionAnswers';
import { isAnswered } from '../../../src/util/questionPicks';

interface Props {
  specs: readonly QuestionSpec[];
  picks: readonly number[][];
  notes: readonly string[];
  onJump: (questionIndex: number) => void;
}

export function QuestionReview({ specs, picks, notes, onJump }: Props): React.ReactElement {
  return (
    <div className="question-review" aria-label="Review your answers">
      {specs.map((spec, index) => {
        const chosen = picks[index] ?? [];
        const note = notes[index] ?? '';
        const answered = isAnswered(chosen, note);
        const summary = answered
          ? formatStructuredAnswer([spec], {
              answers: [{ picks: [...chosen], ...(note.trim() ? { note } : {}) }],
            })
          : 'Not answered';
        return (
          <button
            key={`${index}-${spec.prompt}`}
            type="button"
            className="question-review-row"
            onClick={() => onJump(index)}
            aria-label={`Edit ${spec.header ?? spec.prompt}`}
          >
            <span className="question-review-heading">
              {answered && (
                <span className="question-review-check" aria-hidden="true">
                  ✓
                </span>
              )}
              <span>{spec.prompt}</span>
            </span>
            <span className={answered ? 'question-review-answer' : 'question-review-unanswered'}>
              {summary || 'Not answered'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
