// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ConfirmationDialog } = await import('../../webview-ui/src/components/ConfirmationDialog');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;
const actions = {
  approve: vi.fn(),
  allow: vi.fn(),
  always: vi.fn(),
  deny: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  actions.approve.mockClear();
  actions.allow.mockClear();
  actions.always.mockClear();
  actions.deny.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      React.createElement(ConfirmationDialog, {
        toolName: 'web_fetch',
        detail: 'GET https://a.example/',
        allowForChat: { keys: ['net:a.example'], label: 'any request to a.example' },
        alwaysInProject: { keys: ['net:a.example'], label: 'any request to a.example' },
        onApprove: actions.approve,
        onAllowForChat: actions.allow,
        onAlwaysInProject: actions.always,
        onDeny: actions.deny,
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('ConfirmationDialog', () => {
  it('disables all decisions for 600 ms, then enables them', () => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.confirm-actions button')];
    expect(buttons).toHaveLength(4);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    for (const button of buttons) {
      act(() => button.click());
      act(() =>
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      );
    }
    expect(actions.deny).not.toHaveBeenCalled();
    expect(actions.allow).not.toHaveBeenCalled();
    expect(actions.always).not.toHaveBeenCalled();
    expect(actions.approve).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(600));
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    act(() => buttons[1]!.click());
    expect(actions.allow).toHaveBeenCalledOnce();
  });
});
