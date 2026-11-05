import React from 'react';
import { formatStructuredAnswer, type QuestionSpec } from '../../../src/util/questionAnswers';
import type { QuestionAnswerRecord } from '../../../src/util/questionAnswers';
import { isAnswered } from '../../../src/util/questionPicks';

interface Props {
  specs: readonly QuestionSpec[];
  picks: readonly number[][];
  notes: readonly string[];
  onJump?: (questionIndex: number) => void;
  readOnly?: boolean;
  skipped?: boolean;
}

export function QuestionReview({
  specs,
  picks,
  notes,
  onJump,
  readOnly = false,
  skipped = false,
}: Props): React.ReactElement {
  return (
    <div
      className="question-review"
      aria-label={readOnly ? 'Question answers' : 'Review your answers'}
    >
      {specs.map((spec, index) => {
        const chosen = picks[index] ?? [];
        const note = notes[index] ?? '';
        const answered = !skipped && isAnswered(chosen, note);
        const summary = skipped
          ? 'Skipped'
          : answered
            ? formatStructuredAnswer([spec], {
                answers: [{ picks: [...chosen], ...(note.trim() ? { note } : {}) }],
              })
            : 'Not answered';
        const contents = (
          <>
            <span className="question-review-heading">
              {answered && (
                <span className="question-review-check" aria-hidden="true">
                  ✓
                </span>
              )}
              <span>{spec.prompt}</span>
            </span>
            <span className={answered ? 'question-review-answer' : 'question-review-unanswered'}>
              {summary || (skipped ? 'Skipped' : 'Not answered')}
            </span>
          </>
        );
        return onJump && !readOnly ? (
          <button
            key={`${index}-${spec.prompt}`}
            type="button"
            className="question-review-row"
            onClick={() => onJump(index)}
            aria-label={`Edit ${spec.header ?? spec.prompt}`}
          >
            {contents}
          </button>
        ) : (
          <div key={`${index}-${spec.prompt}`} className="question-review-row is-read-only">
            {contents}
          </div>
        );
      })}
    </div>
  );
}

/** Reuses the card's answer summary for the immutable transcript record. */
export function QuestionRecordReview({
  record,
}: {
  record: QuestionAnswerRecord;
}): React.ReactElement {
  const skipped = record.answer.skipped === true;
  return (
    <QuestionReview
      specs={record.specs}
      picks={record.specs.map((_spec, index) => record.answer.answers[index]?.picks ?? [])}
      notes={record.specs.map((_spec, index) => record.answer.answers[index]?.note ?? '')}
      readOnly
      skipped={skipped}
    />
  );
}
