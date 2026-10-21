import { describe, expect, it } from 'vitest';
import { normalizeQuestions } from '../../src/util/questionAnswers';
import {
  applyRemoteQuestionStep,
  applyRemoteQuestionText,
  createRemoteQuestionStepState,
  renderRemoteQuestionNotePrompt,
  renderRemoteQuestionStep,
} from '../../src/remote/RemoteQuestionSteps';

const specs = () =>
  normalizeQuestions({
    prompt: 'Choose the plan',
    questions: [
      {
        header: 'Stores',
        prompt: 'Which stores should the service use?',
        multiSelect: true,
        options: [
          { label: 'Postgres', description: 'relational', exclusive: false },
          { label: 'Redis', description: 'cache only', exclusive: false },
          { label: 'None', exclusive: true },
        ],
      },
      { header: 'Install', prompt: 'Install now?', options: ['Yes', 'No'] },
    ],
  });

describe('RemoteQuestionSteps', () => {
  it('renders step text, descriptions, selection prompt, and note prompt', () => {
    const state = createRemoteQuestionStepState(specs());
    expect(renderRemoteQuestionStep(state)).toContain('Forge asks (1/2) · Stores');
    expect(renderRemoteQuestionStep(state)).toContain('1. Postgres — relational');
    expect(renderRemoteQuestionStep(state)).toContain('Choose any');
    const note = applyRemoteQuestionStep(state, { type: 'note' });
    expect(note.effect.kind).toBe('needNote');
    expect(renderRemoteQuestionNotePrompt(note.state)).toContain('Stores');
  });

  it('toggles multi-picks, rejects an unanswered next, then advances', () => {
    const initial = createRemoteQuestionStepState(specs());
    expect(applyRemoteQuestionStep(initial, { type: 'next' }).effect).toEqual({
      kind: 'toast',
      text: 'Pick an option or add a note first.',
    });
    const pickedA = applyRemoteQuestionStep(initial, { type: 'toggle', optionIndex: 0 });
    expect(pickedA.effect.kind).toBe('rerender');
    const pickedAC = applyRemoteQuestionStep(pickedA.state, { type: 'toggle', optionIndex: 2 });
    expect(pickedAC.state.picks[0]).toEqual([2]);
    const next = applyRemoteQuestionStep(pickedAC.state, { type: 'next' });
    expect(next.effect).toEqual({ kind: 'sendStep', step: 1 });
    expect(next.state.step).toBe(1);
  });

  it('keeps picks and notes when navigating back', () => {
    let state = createRemoteQuestionStepState(specs());
    state = applyRemoteQuestionStep(state, { type: 'toggle', optionIndex: 0 }).state;
    state = applyRemoteQuestionStep(state, { type: 'typed', text: '1,2' }).state;
    state = applyRemoteQuestionStep(state, { type: 'note' }).state;
    state = applyRemoteQuestionStep(state, { type: 'typed', text: 'keep both' }).state;
    state = applyRemoteQuestionStep(state, { type: 'next' }).state;
    const back = applyRemoteQuestionStep(state, { type: 'back' });
    expect(back.effect).toEqual({ kind: 'sendStep', step: 0 });
    expect(back.state.picks[0]).toEqual([0, 1]);
    expect(back.state.notes[0]).toBe('keep both');
  });

  it('resolves typed multi-select numbers and exact labels to option indexes', () => {
    const initial = createRemoteQuestionStepState(specs());
    const typed = applyRemoteQuestionText(initial, '1,3', true, false);
    expect(typed.kind).toBe('step');
    if (typed.kind === 'step') expect(typed.result.state.picks[0]).toEqual([0, 2]);
    const label = applyRemoteQuestionText(initial, 'Redis', true, false);
    if (label.kind === 'step') expect(label.result.state.picks[0]).toEqual([1]);
  });

  it('saves a note and settles a complete structured answer', () => {
    let state = createRemoteQuestionStepState(specs());
    state = applyRemoteQuestionStep(state, { type: 'toggle', optionIndex: 1 }).state;
    state = applyRemoteQuestionStep(state, { type: 'note' }).state;
    const note = applyRemoteQuestionStep(state, { type: 'typed', text: 'warm cache' });
    expect(note.state.freeTextStep).toBeUndefined();
    state = applyRemoteQuestionStep(note.state, { type: 'next' }).state;
    state = applyRemoteQuestionStep(state, { type: 'toggle', optionIndex: 0 }).state;
    const sent = applyRemoteQuestionStep(state, { type: 'next' });
    expect(sent.effect).toEqual({
      kind: 'settle',
      answer: { answers: [{ picks: [1], note: 'warm cache' }, { picks: [0] }] },
    });
  });

  it('keeps note mode active while a pick changes and advances typed fallback input', () => {
    let state = createRemoteQuestionStepState(specs());
    state = applyRemoteQuestionStep(state, { type: 'note' }).state;
    const toggled = applyRemoteQuestionStep(state, { type: 'toggle', optionIndex: 0 });
    expect(toggled.state.freeTextStep).toBe(0);
    const fallback = applyRemoteQuestionText(createRemoteQuestionStepState(specs()), '2', true, true);
    expect(fallback.kind).toBe('step');
    if (fallback.kind === 'step') {
      expect(fallback.previous.picks[0]).toEqual([1]);
      expect(fallback.result.effect).toEqual({ kind: 'sendStep', step: 1 });
    }
  });

  it('allows free-text-only questions, skip, and resolved elsewhere', () => {
    const textOnly = createRemoteQuestionStepState(
      normalizeQuestions({ prompt: 'Why?' }),
    );
    const noteMode = applyRemoteQuestionStep(textOnly, { type: 'note' });
    const answered = applyRemoteQuestionStep(noteMode.state, { type: 'typed', text: 'Because' });
    expect(applyRemoteQuestionStep(answered.state, { type: 'next' }).effect.kind).toBe('settle');
    const skipped = applyRemoteQuestionStep(textOnly, { type: 'skip' });
    expect(skipped.effect.kind).toBe('skip');
    const resolved = applyRemoteQuestionStep(textOnly, { type: 'resolved' });
    expect(resolved.state.resolved).toBe(true);
    expect(applyRemoteQuestionStep(resolved.state, { type: 'next' }).effect.kind).toBe('toast');
  });
});
