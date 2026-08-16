// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * DOM tests for the compact reasoning rows. A long agent turn opens one
 * assistant message per round carrying reasoning and no content; rendered with
 * the full role label and bubble chrome those buried the actual work.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { ThinkingGroup, isReasoningOnly } = await import(
  '../../webview-ui/src/components/ThinkingGroup'
);
const React = await import('react');

function step(id: string, reasoning: string) {
  return { id, role: 'assistant' as const, content: '', reasoning };
}

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

function render(steps: ReturnType<typeof step>[]): void {
  act(() => {
    root.render(React.createElement(ThinkingGroup, { steps }));
  });
}

describe('isReasoningOnly', () => {
  it('matches only assistant messages that carry reasoning and no content', () => {
    expect(isReasoningOnly(step('a', 'pondering'))).toBe(true);
    expect(isReasoningOnly({ id: 'b', role: 'assistant', content: 'done', reasoning: 'x' })).toBe(
      false,
    );
    expect(isReasoningOnly({ id: 'c', role: 'assistant', content: '' })).toBe(false);
    expect(isReasoningOnly({ id: 'd', role: 'tool', content: 'read_file' })).toBe(false);
  });
});

describe('ThinkingGroup', () => {
  it('renders a single round as one collapsed line', () => {
    render([step('a', 'first thought')]);

    const toggles = container.querySelectorAll('.thinking-row-toggle');
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.textContent).toContain('Thinking');
    expect(container.querySelector('.thinking-content')).toBeNull();
    // No role label or bubble chrome — that is the whole point of the row.
    expect(container.querySelector('.msg-role')).toBeNull();
    expect(container.querySelector('.thinking-bubble')).toBeNull();
  });

  it('expands a single round to its reasoning text', () => {
    render([step('a', 'first thought')]);

    act(() => {
      container.querySelector<HTMLButtonElement>('.thinking-row-toggle')!.click();
    });

    expect(container.querySelector('.thinking-content')?.textContent).toBe('first thought');
  });

  it('folds several rounds into one line with a step count', () => {
    render([step('a', 'one'), step('b', 'two'), step('c', 'three')]);

    expect(container.querySelectorAll('.thinking-row-toggle')).toHaveLength(1);
    expect(container.querySelector('.thinking-row-label')?.textContent).toBe('Thinking (3 steps)');

    act(() => {
      container.querySelector<HTMLButtonElement>('.thinking-row-toggle')!.click();
    });

    const rows = container.querySelectorAll('.thinking-group-body .thinking-row');
    expect(rows).toHaveLength(3);
    // Rows inside the group stay closed until individually opened.
    expect(container.querySelectorAll('.thinking-content')).toHaveLength(0);
  });
});
