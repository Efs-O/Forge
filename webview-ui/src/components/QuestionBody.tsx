import React, { useRef, useState } from 'react';
import type { QuestionSpec } from '../../../src/util/questionAnswers';

interface Props {
  spec: QuestionSpec;
  questionIndex: number;
  picks: readonly number[];
  note: string;
  /** The tool's placeholder, used when the question is free text only. */
  placeholder?: string | undefined;
  onToggle: (optionIndex: number) => void;
  onNoteChange: (note: string) => void;
}

export function QuestionBody({
  spec,
  questionIndex,
  picks,
  note,
  placeholder,
  onToggle,
  onNoteChange,
}: Props): React.ReactElement {
  const [writingOwn, setWritingOwn] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const role = spec.multiSelect ? 'checkbox' : 'radio';

  return (
    <div className="question-body">
      <div className="question-heading">
        <span className="question-header-chip">
          {spec.header ?? `Question ${questionIndex + 1}`}
        </span>
        <span className="question-choice-hint">
          {spec.multiSelect ? 'Choose any' : 'Choose one'}
        </span>
      </div>
      <div className="question-prompt">{spec.prompt}</div>
      {spec.options.length > 0 && (
        <div
          className="question-options"
          role={spec.multiSelect ? 'group' : 'radiogroup'}
          aria-label={spec.prompt}
        >
          {spec.options.map((option, optionIndex) => {
            const selected = picks.includes(optionIndex);
            return (
              <button
                key={`${optionIndex}-${option.label}`}
                type="button"
                className={`question-option${selected ? ' is-selected' : ''}`}
                role={role}
                aria-checked={selected}
                onClick={() => onToggle(optionIndex)}
              >
                <span className="question-option-mark" aria-hidden="true">
                  {selected ? (spec.multiSelect ? '✓' : '●') : spec.multiSelect ? '□' : '○'}
                </span>
                <span className="question-option-copy">
                  <span className="question-option-label">
                    {option.label}
                    {option.recommended && (
                      <span className="question-option-badge">Recommended</span>
                    )}
                  </span>
                  {option.description && (
                    <span className="question-option-description">{option.description}</span>
                  )}
                </span>
                <span className="question-option-key" aria-hidden="true">
                  {optionIndex + 1}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {spec.options.length > 0 && (
        <button
          type="button"
          className="question-write-link"
          onClick={() => {
            setWritingOwn(true);
            textareaRef.current?.focus();
          }}
        >
          Or write your own answer
        </button>
      )}
      <textarea
        ref={textareaRef}
        className="question-note"
        rows={2}
        maxLength={4000}
        aria-label={spec.options.length ? 'Optional note or own answer' : 'Your answer'}
        value={note}
        placeholder={
          spec.options.length === 0
            ? (placeholder ?? 'Your answer…')
            : writingOwn
              ? 'Your answer…'
              : 'Add a note (optional)'
        }
        onChange={(event) => onNoteChange(event.target.value)}
      />
    </div>
  );
}
