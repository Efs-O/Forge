// @vitest-environment jsdom
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } })
  .acquireVsCodeApi = () => ({
  postMessage: (msg: unknown) => posted.push(msg),
});

const { App } = await import('../../webview-ui/src/App');
const React = await import('react');

function hostMessage(message: HostToWebview): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('App heavy streaming load', () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;
  const uncaught: unknown[] = [];
  const onWindowError = (event: ErrorEvent): void => {
    uncaught.push(event.error ?? event.message);
    event.preventDefault();
  };

  beforeEach(() => {
    posted.length = 0;
    uncaught.length = 0;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.addEventListener('error', onWindowError);
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(App)));
    act(() => {
      hostMessage({
        type: 'sessionSync',
        activeId: 'stress-conversation',
        tabs: [
          {
            id: 'stress-conversation',
            title: 'Stress test',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        history: [],
        messagesById: { 'stress-conversation': [] },
      });
      hostMessage({ type: 'generationStarted', conversationId: 'stress-conversation' });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.removeEventListener('error', onWindowError);
    consoleError.mockRestore();
  });

  it(
    'survives 6,000 individually committed stream fragments while the user types',
    () => {
      const textarea = container.querySelector<HTMLTextAreaElement>('#prompt')!;

      act(() => {
        for (let index = 0; index < 6_000; index++) {
          flushSync(() => {
            hostMessage({
              type: index % 4 === 0 ? 'reasoningToken' : 'token',
              text: index % 23 === 0 ? ' chunk\n' : 'x',
              conversationId: 'stress-conversation',
            });
          });
          if (index % 100 === 0) {
            flushSync(() => setNativeTextareaValue(textarea, `prompt edit ${index}`));
          }
        }
      });

      const reactDepthErrors = consoleError.mock.calls.filter((args) =>
        args.some((arg) => String(arg).includes('Maximum update depth exceeded')),
      );
      expect(uncaught).toEqual([]);
      expect(reactDepthErrors).toEqual([]);
      expect(textarea.value).toBe('prompt edit 5900');
      expect(container.textContent).toContain('Burning tokens');
    },
    60_000,
  );
});
