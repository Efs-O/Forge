import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatGroupAnswer, type QuestionGroup } from '../../../src/util/questionAnswers';
import { QuestionGroups } from './QuestionGroups';

interface Props {
  prompt: string;
  placeholder?: string | undefined;
  options?: readonly string[] | undefined;
  questions?: readonly QuestionGroup[] | undefined;
  onAnswer: (text: string) => void;
  onDismiss: () => void;
}

const QuestionIcon = (): React.ReactElement => (
  <svg
    className="question-icon"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm.02 10.25a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zM8.1 3.6c1.47 0 2.55.9 2.55 2.16 0 .87-.42 1.44-1.2 1.98-.6.42-.79.66-.79 1.14v.3H7.36v-.45c0-.84.3-1.29 1.02-1.8.6-.42.79-.69.79-1.14 0-.54-.45-.93-1.09-.93-.66 0-1.13.42-1.17 1.05H5.55C5.6 4.5 6.63 3.6 8.1 3.6z" />
  </svg>
);

/**
 * An agent question, asked where the rest of the turn is.
 *
 * `ask_user` used to reach only `vscode.window`, so a multiple-choice question
 * opened the command palette's quick pick over the editor while the sidebar --
 * the surface the user was actually reading -- showed nothing. Modelled on
 * ConfirmationDialog so the two modals behave and look the same; the one real
 * difference is that a question can want free text back.
 */
export function QuestionDialog({
  prompt,
  placeholder,
  options,
  questions,
  onAnswer,
  onDismiss,
}: Props): React.ReactElement {
  const [text, setText] = useState('');
  const [showOther, setShowOther] = useState(false);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const groups = questions?.length ? questions : undefined;
  const showFreeText = (!options?.length && !groups) || showOther;
  // Sub-questions are answered together or not at all: a partial set would
  // reach the model as a decision it never made on the group left blank.
  const groupAnswer = useMemo(() => {
    if (!groups) return undefined;
    const chosen = groups.map((_, index) => picks[index]);
    if (chosen.some((pick) => pick === undefined)) return undefined;
    return formatGroupAnswer(groups, chosen as string[]);
  }, [groups, picks]);

  // The question is raised mid-turn while the transcript streams, so nothing
  // else is going to hand it focus. `Other…` changes this component in place,
  // so its textarea needs the same focus hand-off after it appears.
  useEffect(() => {
    inputRef.current?.focus();
  }, [showFreeText]);

  // Typed text wins when there is any: opening `Other…` and writing in it is an
  // explicit override of whatever was clicked above.
  const submit = useCallback(() => {
    const answer = text.trim() || groupAnswer;
    if (answer) onAnswer(answer);
  }, [text, groupAnswer, onAnswer]);

  const pick = useCallback((groupIndex: number, option: string) => {
    setPicks((current) => ({ ...current, [groupIndex]: option }));
  }, []);

  // Escape lives on the document, not on the textarea: the options variant has
  // no text field to carry the handler, and a modal that only closes when the
  // right element happens to hold focus is a modal that traps the user.
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onDismiss]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      // Enter sends, Shift+Enter breaks the line — the same contract as the
      // main input row, so the muscle memory carries over.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <div
      className="confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Forge is asking a question"
    >
      <div className="confirm-dialog question-dialog">
        <div className="confirm-header">
          <QuestionIcon />
          <span className="confirm-tool-name">Forge asks</span>
        </div>
        <div className="question-prompt">{prompt}</div>

        {groups && <QuestionGroups groups={groups} picks={picks} onPick={pick} />}

        {/* The options stay mounted once `Other…` is open. Swapping them out for
            the textarea stranded the user: the choices they were reading were
            gone and nothing offered them back, so a mis-click became a forced
            essay. */}
        {!groups && options?.length ? (
          <div className="question-options">
            {options.map((option, index) => (
              <button
                key={`${index}-${option}`}
                className="question-option"
                type="button"
                onClick={() => onAnswer(option)}
              >
                <span className="question-option-index">{index + 1}</span>
                <span className="question-option-label">{option}</span>
              </button>
            ))}
          </div>
        ) : null}

        {!showOther && (options?.length || groups) ? (
          <button className="question-other" type="button" onClick={() => setShowOther(true)}>
            Other…
          </button>
        ) : null}

        {showFreeText && (
          <textarea
            ref={inputRef}
            className="question-input"
            rows={3}
            value={text}
            placeholder={placeholder ?? 'Your answer…'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}

        <div className="confirm-actions">
          <button className="confirm-btn-deny" type="button" onClick={onDismiss}>
            Dismiss
          </button>
          {(showFreeText || groups) && (
            <button
              className="confirm-btn-approve"
              type="button"
              onClick={submit}
              disabled={!text.trim() && !groupAnswer}
            >
              Answer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
