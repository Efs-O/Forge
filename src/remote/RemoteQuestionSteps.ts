import {
  formatStructuredAnswer,
  renderQuestionAsText,
  resolveAnswerPicks,
  type QuestionSpec,
  type StructuredAnswer,
} from '../util/questionAnswers';
import { isAnswered, togglePick } from '../util/questionPicks';
import { telegramQuestionButtons } from './TelegramQuestionButtons';
import type { RemoteContactButton } from './types';

export interface RemoteQuestionStepState {
  specs: readonly QuestionSpec[];
  step: number;
  picks: number[][];
  notes: string[];
  freeTextStep?: number;
  resolved: boolean;
}

export type RemoteQuestionStepAction =
  | { type: 'toggle'; optionIndex: number }
  | { type: 'note' }
  | { type: 'typed'; text: string }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'skip' }
  | { type: 'resolved' };

export type RemoteQuestionStepEffect =
  | { kind: 'rerender' }
  | { kind: 'sendStep'; step: number }
  | { kind: 'needNote' }
  | { kind: 'settle'; answer: StructuredAnswer }
  | { kind: 'skip' }
  | { kind: 'toast'; text: string };

export interface RemoteQuestionStepResult {
  state: RemoteQuestionStepState;
  effect: RemoteQuestionStepEffect;
}

export type RemoteQuestionTextResult =
  | { kind: 'plain' }
  | { kind: 'step'; previous: RemoteQuestionStepState; result: RemoteQuestionStepResult };

export type RemoteQuestionCallbackAction = 'select' | 'note' | 'next' | 'back' | 'skip';

export function createRemoteQuestionStepState(
  specs: readonly QuestionSpec[],
): RemoteQuestionStepState {
  if (specs.length === 0) throw new RangeError('A remote question needs at least one spec.');
  return {
    specs,
    step: 0,
    picks: specs.map(() => []),
    notes: specs.map(() => ''),
    resolved: false,
  };
}

export function questionStepAction(
  action: RemoteQuestionCallbackAction,
  choice?: number,
): RemoteQuestionStepAction | undefined {
  if (action === 'select') {
    return choice === undefined ? undefined : { type: 'toggle', optionIndex: choice - 1 };
  }
  return action === 'note'
    ? { type: 'note' }
    : action === 'next'
      ? { type: 'next' }
      : action === 'back'
        ? { type: 'back' }
        : { type: 'skip' };
}

export function renderRemoteQuestionStep(
  state: RemoteQuestionStepState,
  step = state.step,
): string {
  const spec = state.specs[step]!;
  const stepName = spec.header?.trim() || truncate(spec.prompt.trim(), 38);
  const prefix =
    state.specs.length > 1
      ? `Forge asks (${step + 1}/${state.specs.length})${stepName ? ` · ${stepName}` : ''}`
      : `Forge asks${stepName ? ` · ${stepName}` : ''}`;
  const note = state.notes[step]?.trim() ? `\n\n📝 Note added: ${state.notes[step]}` : '';
  return `${prefix}\n${renderQuestionAsText(spec.prompt, spec)}${note}`;
}

export function renderRemoteQuestionNotePrompt(state: RemoteQuestionStepState): string {
  const spec = state.specs[state.step]!;
  const name = spec.header?.trim() || `question ${state.step + 1}`;
  return `Send your note for “${name}” as a message.`;
}

export function renderRemoteQuestionStepReceipt(
  state: RemoteQuestionStepState,
  step: number,
): string {
  const spec = state.specs[step]!;
  const picks = state.picks[step] ?? [];
  const note = state.notes[step] ?? '';
  const answer = isAnswered(picks, note)
    ? formatRemoteQuestionStepAnswer(spec, picks, note)
    : 'Your selections and note are saved.';
  return `${renderRemoteQuestionStep(state, step)}\n\n✓ Answer: ${answer}`;
}

export function formatRemoteQuestionStepAnswer(
  spec: QuestionSpec,
  picks: readonly number[],
  note: string,
): string {
  return formatStructuredAnswer([spec], {
    answers: [{ picks: [...picks], ...(note.trim() ? { note } : {}) }],
  });
}

export function buildRemoteQuestionKeyboard(
  questionId: string,
  state: RemoteQuestionStepState,
): RemoteContactButton[][] {
  const spec = state.specs[state.step]!;
  return telegramQuestionButtons(
    questionId,
    spec,
    state.picks[state.step] ?? [],
    state.step,
    state.specs.length,
  );
}

/** Pure per-question Telegram state transition; the bridge performs the effects. */
export function applyRemoteQuestionStep(
  state: RemoteQuestionStepState,
  action: RemoteQuestionStepAction,
): RemoteQuestionStepResult {
  if (action.type === 'resolved') {
    return { state: { ...state, resolved: true }, effect: { kind: 'rerender' } };
  }
  if (state.resolved) return toast(state, 'Forge already received an answer to this question.');

  const spec = state.specs[state.step]!;
  const picks = state.picks[state.step] ?? [];
  const note = state.notes[state.step] ?? '';

  switch (action.type) {
    case 'toggle': {
      if (!spec.options[action.optionIndex]) return toast(state, 'That choice is unavailable.');
      const nextPicks = togglePick(spec, picks, action.optionIndex);
      return {
        state: withStepValue(state, state.step, nextPicks, note, true),
        effect: { kind: 'rerender' },
      };
    }
    case 'note':
      return {
        state: { ...state, freeTextStep: state.step },
        effect: { kind: 'needNote' },
      };
    case 'typed': {
      if (state.freeTextStep === state.step) {
        return {
          state: withStepValue(state, state.step, picks, action.text),
          effect: { kind: 'rerender' },
        };
      }
      const resolvedPicks = resolveAnswerPicks(action.text, spec);
      if (!resolvedPicks) return toast(state, 'Tap a choice or Note… to answer this question.');
      return {
        state: withStepValue(state, state.step, resolvedPicks, note),
        effect: { kind: 'rerender' },
      };
    }
    case 'next':
      if (!isAnswered(picks, note)) {
        return toast(state, 'Pick an option or add a note first.');
      }
      if (state.step + 1 < state.specs.length) {
        const step = state.step + 1;
        return { state: { ...state, step }, effect: { kind: 'sendStep', step } };
      }
      return {
        state: { ...state, resolved: true },
        effect: {
          kind: 'settle',
          answer: structuredAnswer(state),
        },
      };
    case 'back': {
      if (state.step === 0) return toast(state, 'There is no earlier question.');
      const step = state.step - 1;
      return { state: { ...state, step }, effect: { kind: 'sendStep', step } };
    }
    case 'skip':
      return { state: { ...state, resolved: true }, effect: { kind: 'skip' } };
  }
}

/** Decide whether typed input is a note, an option pick, or a plain answer. */
export function applyRemoteQuestionText(
  state: RemoteQuestionStepState,
  text: string,
  supportsOptionText: boolean,
  advanceAfterText: boolean,
): RemoteQuestionTextResult {
  const noteMode = state.freeTextStep === state.step;
  if (!noteMode && !supportsOptionText) return { kind: 'plain' };
  const typed = applyRemoteQuestionStep(state, { type: 'typed', text });
  if (typed.effect.kind === 'toast' || noteMode || !advanceAfterText) {
    return { kind: 'step', previous: state, result: typed };
  }
  const next = applyRemoteQuestionStep(typed.state, { type: 'next' });
  return { kind: 'step', previous: typed.state, result: next };
}

function withStepValue(
  state: RemoteQuestionStepState,
  step: number,
  picks: number[],
  note: string,
  preserveFreeText = false,
): RemoteQuestionStepState {
  return {
    specs: state.specs,
    step: state.step,
    picks: state.picks.map((current, index) => (index === step ? [...picks] : current)),
    notes: state.notes.map((current, index) => (index === step ? note : current)),
    ...(preserveFreeText && state.freeTextStep === step ? { freeTextStep: step } : {}),
    resolved: state.resolved,
  };
}

function structuredAnswer(state: RemoteQuestionStepState): StructuredAnswer {
  return {
    answers: state.specs.map((_spec, index) => {
      const note = state.notes[index] ?? '';
      return {
        picks: [...(state.picks[index] ?? [])],
        ...(note.trim() ? { note } : {}),
      };
    }),
  };
}

function toast(state: RemoteQuestionStepState, text: string): RemoteQuestionStepResult {
  return { state, effect: { kind: 'toast', text } };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
