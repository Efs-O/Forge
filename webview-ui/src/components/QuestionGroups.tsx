import React from 'react';
import type { QuestionGroup } from '../../../src/util/questionAnswers';

interface Props {
  groups: readonly QuestionGroup[];
  /** The chosen option per group, by group index. */
  picks: Readonly<Record<number, string>>;
  onPick: (groupIndex: number, option: string) => void;
}

/**
 * Two or more sub-questions, each with its own choice list.
 *
 * Split from QuestionDialog because the buttons mean something different here:
 * a single-question option button IS the answer and sends immediately, while
 * these select and wait, since an answer is only complete once every
 * sub-question has one. Numbering matches `renderQuestionAsText`, so the reply
 * a phone types and the buttons clicked here address the same options.
 */
export function QuestionGroups({ groups, picks, onPick }: Props): React.ReactElement {
  return (
    <div className="question-groups">
      {groups.map((group, groupIndex) => (
        <fieldset className="question-group" key={`${groupIndex}-${group.prompt}`}>
          <legend className="question-group-prompt">
            <span className="question-option-index">{groupIndex + 1}</span>
            {group.prompt}
          </legend>
          <div className="question-options">
            {group.options.map((option, index) => {
              const selected = picks[groupIndex] === option;
              return (
                <button
                  key={`${index}-${option}`}
                  className={`question-option${selected ? ' question-option-selected' : ''}`}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onPick(groupIndex, option)}
                >
                  <span className="question-option-index">{index + 1}</span>
                  <span className="question-option-label">{option}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
