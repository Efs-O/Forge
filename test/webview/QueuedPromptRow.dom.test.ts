// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { QueuedPromptRow } = await import('../../webview-ui/src/components/QueuedPromptRow');
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

describe('QueuedPromptRow', () => {
  it('shows Steer and Cancel actions beside the queued message', () => {
    const onSteer = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      root.render(
        React.createElement(QueuedPromptRow, {
          text: 'Run the tests after this task.',
          attachmentCount: 1,
          onSteer,
          onCancel,
        }),
      );
    });

    expect(container.textContent).toContain('Run the tests after this task.');
    expect(container.textContent).toContain('Queued · 1 attachment');
    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    expect(Array.from(buttons, (button) => button.textContent)).toEqual(['Steer', 'Cancel']);
    act(() => buttons[0]!.click());
    expect(onSteer).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    act(() => buttons[1]!.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
