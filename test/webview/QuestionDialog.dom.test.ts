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
});
