// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { Message } = await import('../../webview-ui/src/components/Message');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 17, 18, 0));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('message timestamps', () => {
  it('shows a local time on user and assistant messages', () => {
    act(() => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Message, {
            role: 'user',
            content: 'Question',
            createdAt: new Date(2026, 9, 17, 9, 5).getTime(),
          }),
          React.createElement(Message, {
            role: 'assistant',
            content: 'Answer',
            createdAt: new Date(2026, 9, 17, 9, 6).getTime(),
          }),
        ),
      );
    });

    expect(
      [...container.querySelectorAll('time.message-timestamp')].map((time) => time.textContent),
    ).toEqual(['09:05', '09:06']);
  });

  it('shows the date for older messages and no time for missing or invalid values', () => {
    act(() => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Message, {
            role: 'assistant',
            content: 'Yesterday',
            createdAt: new Date(2026, 9, 16, 23, 45).getTime(),
          }),
          React.createElement(Message, { role: 'user', content: 'Old row' }),
          React.createElement(Message, {
            role: 'assistant',
            content: 'Bad date',
            createdAt: Number.NaN,
          }),
        ),
      );
    });

    expect(container.querySelector('time.message-timestamp')?.textContent).toContain('23:45');
    expect(container.querySelectorAll('time.message-timestamp')).toHaveLength(1);
  });
});
