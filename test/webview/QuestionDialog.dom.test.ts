// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionSpec, StructuredAnswer } from '../../src/util/questionAnswers';
import type { AgentQuestion, QuestionDraft } from '../../webview-ui/src/useAgentDialogs';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { QuestionDialog } = await import('../../webview-ui/src/components/QuestionDialog');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;

interface HarnessProps {
  question: AgentQuestion;
  autoFocus?: boolean;
  onAnswer: (answer: StructuredAnswer) => void;
  onSkip: () => void;
}

function initialDraft(specs: readonly QuestionSpec[]): QuestionDraft {
  return { tab: 0, picks: specs.map(() => []), notes: specs.map(() => '') };
}

function Harness({
  question,
  autoFocus = true,
  onAnswer,
  onSkip,
}: HarnessProps): React.ReactElement {
  const [draft, setDraft] = React.useState(() => initialDraft(question.specs));
  return React.createElement(QuestionDialog, {
    question,
    draft,
    autoFocus,
    onDraftChange: setDraft,
    onAnswer,
    onSkip,
  });
}

function question(specs: QuestionSpec[]): AgentQuestion {
  return {
    type: 'question',
    id: `question-${specs.length}`,
    prompt: specs[0]?.prompt ?? 'Question?',
    specs,
    focusOnOpen: true,
  };
}

function render(specs: QuestionSpec[], autoFocus = true) {
  const onAnswer = vi.fn<(answer: StructuredAnswer) => void>();
  const onSkip = vi.fn();
  act(() =>
    root.render(
      React.createElement(Harness, { question: question(specs), autoFocus, onAnswer, onSkip }),
    ),
  );
  return { onAnswer, onSkip };
}

function type(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('QuestionDialog', () => {
  it('focuses the card only when requested and never dismisses on Escape', () => {
    const spec: QuestionSpec = {
      prompt: 'Which reviewer?',
      multiSelect: false,
      options: [{ label: 'Codex' }, { label: 'Claude' }],
    };
    const { onSkip } = render([spec], false);
    expect(document.activeElement).not.toBe(container.querySelector('[role="dialog"]'));
    act(() =>
      root.render(
        React.createElement(Harness, {
          question: question([spec]),
          autoFocus: true,
          onAnswer: vi.fn(),
          onSkip,
        }),
      ),
    );
    const panel = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(panel);

    const note = container.querySelector<HTMLTextAreaElement>('.question-note')!;
    act(() => note.focus());
    act(() => note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(panel);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('tags the recommended option without preselecting it', () => {
    const { onAnswer } = render([
      {
        prompt: 'Bump the version?',
        multiSelect: false,
        options: [{ label: 'Bump', recommended: true }, { label: 'Keep' }],
      },
    ]);
    const options = [...container.querySelectorAll<HTMLButtonElement>('.question-option')];
    expect(options[0]!.querySelector('.question-option-badge')?.textContent).toBe('Recommended');
    expect(options[1]!.querySelector('.question-option-badge')).toBeNull();
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
    ]);
    const answer = container.querySelector<HTMLButtonElement>('.question-answer')!;
    expect(answer.disabled).toBe(true);
    act(() => options[0]!.click());
    act(() => answer.click());
    expect(onAnswer).toHaveBeenCalledWith({ answers: [{ picks: [0] }] });
  });

  it('keeps multi-picks with a note and sends option indexes in spec order', () => {
    const { onAnswer } = render([
      {
        prompt: 'Which stores?',
        header: 'Database',
        multiSelect: true,
        options: [
          { label: 'Postgres', description: 'Relational store' },
          { label: 'Redis', description: 'Cache only' },
        ],
      },
    ]);
    expect(document.activeElement).toBe(container.querySelector('[role="dialog"]'));
    expect(container.querySelector('.question-header-chip')?.textContent).toBe('Database');
    expect(container.querySelector('.question-choice-hint')?.textContent).toBe('Choose any');
    expect(container.querySelector('.question-option-description')?.textContent).toBe(
      'Relational store',
    );
    const options = [...container.querySelectorAll<HTMLButtonElement>('.question-option')];
    act(() => options[1]!.click());
    act(() => options[0]!.click());
    const note = container.querySelector<HTMLTextAreaElement>('.question-note')!;
    act(() => type(note, 'keep the old schema'));

    const answer = container.querySelector<HTMLButtonElement>('.question-answer')!;
    expect(answer.disabled).toBe(false);
    act(() => answer.click());
    expect(onAnswer).toHaveBeenCalledWith({
      answers: [{ picks: [0, 1], note: 'keep the old schema' }],
    });
  });

  it('allows a note-only own answer and the single-question Answer button stays disabled otherwise', () => {
    const { onAnswer } = render([
      { prompt: 'Choose a language', multiSelect: false, options: [{ label: 'TypeScript' }] },
    ]);
    const answer = container.querySelector<HTMLButtonElement>('.question-answer')!;
    expect(answer.disabled).toBe(true);
    const panel = container.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => panel.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })));
    expect(container.querySelector('.question-option')?.getAttribute('aria-checked')).toBe('true');
    act(() => panel.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })));
    expect(container.querySelector('.question-option')?.getAttribute('aria-checked')).toBe('false');
    act(() => container.querySelector<HTMLButtonElement>('.question-write-link')!.click());
    const note = container.querySelector<HTMLTextAreaElement>('.question-note')!;
    expect(note.placeholder).toBe('Your answer…');
    act(() => type(note, 'Rust'));
    expect(answer.disabled).toBe(false);
    act(() => answer.click());
    expect(onAnswer).toHaveBeenCalledWith({ answers: [{ picks: [], note: 'Rust' }] });
  });

  it('moves through tabs to Review and lets unanswered rows jump back', () => {
    const specs: QuestionSpec[] = [
      {
        prompt: 'Which database?',
        header: 'Database',
        multiSelect: false,
        options: [{ label: 'SQLite' }, { label: 'Postgres' }],
      },
      { prompt: 'Enable cache?', header: 'Cache', multiSelect: false, options: [{ label: 'Yes' }] },
    ];
    const { onAnswer } = render(specs);
    const next = (): HTMLButtonElement => container.querySelector('.question-answer')!;
    expect(next().textContent).toBe('Next');
    const firstTab = container.querySelector<HTMLButtonElement>('#question-tab-0')!;
    act(() => firstTab.focus());
    act(() =>
      firstTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(document.activeElement).toBe(container.querySelector('#question-tab-1'));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('#question-tab-1')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(document.activeElement).toBe(container.querySelector('#question-tab-0'));
    act(() => next().click());
    expect(container.querySelector('.question-prompt')?.textContent).toBe('Enable cache?');
    act(() => container.querySelector<HTMLButtonElement>('.question-option')!.click());
    act(() => next().click());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Review',
    );
    expect(container.querySelector('.question-review-unanswered')?.textContent).toBe(
      'Not answered',
    );
    expect(next().disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('.question-review-row')!.click());
    expect(container.querySelector('.question-prompt')?.textContent).toBe('Which database?');
    act(() => container.querySelectorAll<HTMLButtonElement>('.question-option')[1]!.click());
    act(() => container.querySelector<HTMLButtonElement>('#question-tab-review')!.click());
    expect(next().disabled).toBe(false);
    act(() => next().click());
    expect(onAnswer).toHaveBeenCalledWith({
      answers: [{ picks: [1] }, { picks: [0] }],
    });
  });

  it('uses Enter to submit from a card field and Shift+Enter remains a newline', () => {
    const { onAnswer } = render([{ prompt: 'Your answer?', multiSelect: false, options: [] }]);
    const note = container.querySelector<HTMLTextAreaElement>('.question-note')!;
    act(() => type(note, 'A written answer'));
    act(() =>
      note.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
      ),
    );
    expect(onAnswer).not.toHaveBeenCalled();
    act(() => note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onAnswer).toHaveBeenCalledWith({ answers: [{ picks: [], note: 'A written answer' }] });
  });
});
