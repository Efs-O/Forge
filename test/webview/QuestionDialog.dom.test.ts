// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { QuestionDialog } = await import('../../webview-ui/src/components/QuestionDialog');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * React tracks a controlled input's value on the node itself, so a bare
 * `el.value = x` is ignored as "no change" and onChange never fires. Going
 * through the prototype setter is what makes the event real.
 */
function type(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function render(onAnswer = vi.fn()): typeof onAnswer {
  act(() => {
    root.render(
      React.createElement(QuestionDialog, {
        prompt: 'Which reviewer should continue?',
        options: ['Codex', 'Claude'],
        onAnswer,
        onDismiss: vi.fn(),
      }),
    );
  });
  return onAnswer;
}

describe('QuestionDialog', () => {
  it('keeps numbered options as immediate answers', () => {
    const onAnswer = render();

    act(() => container.querySelector<HTMLButtonElement>('.question-option')!.click());

    expect(onAnswer).toHaveBeenCalledWith('Codex');
  });

  it('offers Other… and switches it to the focused free-text answer path', () => {
    render();

    expect(container.querySelector('.question-input')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.question-other')!.click());

    const input = container.querySelector<HTMLTextAreaElement>('.question-input');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(container.querySelector<HTMLButtonElement>('.confirm-btn-approve')).not.toBeNull();
  });

  it('leaves the options answerable after Other… opens the text box', () => {
    const onAnswer = render();

    act(() => container.querySelector<HTMLButtonElement>('.question-other')!.click());

    const shown = [...container.querySelectorAll('.question-option-label')].map((el) => el.textContent);
    expect(shown).toEqual(['Codex', 'Claude']);
    // The link is spent once its box is open -- nothing left for it to reveal.
    expect(container.querySelector('.question-other')).toBeNull();

    act(() => container.querySelectorAll<HTMLButtonElement>('.question-option')[1]!.click());
    expect(onAnswer).toHaveBeenCalledWith('Claude');
  });
});

describe('QuestionDialog with sub-questions', () => {
  const onAnswer = vi.fn();

  function renderGroups(): void {
    act(() => {
      root.render(
        React.createElement(QuestionDialog, {
          prompt: 'Two decisions:',
          questions: [
            { prompt: 'Version', options: ['bump', 'keep'] },
            { prompt: 'Install', options: ['open', 'skip'] },
          ],
          onAnswer,
          onDismiss: vi.fn(),
        }),
      );
    });
  }

  beforeEach(() => onAnswer.mockClear());

  it('holds the answer until every sub-question has a pick', () => {
    renderGroups();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.question-option')];
    const answer = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('.confirm-btn-approve')!;

    // A click selects here rather than answering: a partial set would reach the
    // model as a decision that was never made.
    act(() => buttons[1]!.click());
    expect(onAnswer).not.toHaveBeenCalled();
    expect(answer().disabled).toBe(true);
    expect(buttons[1]!.className).toContain('question-option-selected');

    act(() => buttons[2]!.click());
    expect(answer().disabled).toBe(false);
    act(() => answer().click());
    expect(onAnswer).toHaveBeenCalledWith('Version: keep\nInstall: open');
  });

  it('lets a typed answer override the picks', () => {
    renderGroups();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.question-option')];
    act(() => buttons[0]!.click());
    act(() => buttons[2]!.click());
    act(() => container.querySelector<HTMLButtonElement>('.question-other')!.click());

    const input = container.querySelector<HTMLTextAreaElement>('.question-input')!;
    act(() => type(input, 'neither — ship it unversioned'));
    act(() => container.querySelector<HTMLButtonElement>('.confirm-btn-approve')!.click());
    expect(onAnswer).toHaveBeenCalledWith('neither — ship it unversioned');
  });
});
