// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => undefined });

const React = await import('react');
const { MessageList } = await import('../../webview-ui/src/components/MessageList');

let container: HTMLDivElement;
let root: Root;
let scrollTop: number;

function render(
  messages: Array<{ id: string; role: 'assistant'; content: string }>,
  active = true,
): void {
  act(() => {
    root.render(
      React.createElement(MessageList, {
        messages,
        queuedPrompts: [],
        onCancelQueuedPrompt: () => undefined,
        streaming: true,
        conversationId: 'chat-1',
        active,
        activityView: 'full',
      }),
    );
  });
}

beforeEach(() => {
  scrollTop = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function setScrollGeometry(pane: HTMLElement): void {
  Object.defineProperties(pane, {
    scrollHeight: { configurable: true, get: () => 1200 },
    clientHeight: { configurable: true, get: () => 300 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
}

describe('MessageList scroll intent', () => {
  it('continues following after a layout-driven upward scroll event', () => {
    render([]);
    const pane = container.querySelector<HTMLElement>('.messages-pane')!;
    setScrollGeometry(pane);
    scrollTop = 400;
    act(() => pane.dispatchEvent(new Event('scroll')));

    render([{ id: 'a1', role: 'assistant', content: 'New streamed text' }]);
    expect(scrollTop).toBe(1200);
  });

  it('stops following after the reader wheels up and preserves their position', () => {
    render([]);
    const pane = container.querySelector<HTMLElement>('.messages-pane')!;
    setScrollGeometry(pane);
    act(() => pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -80 })));
    scrollTop = 400;
    act(() => pane.dispatchEvent(new Event('scroll')));

    render([{ id: 'a1', role: 'assistant', content: 'New streamed text' }]);
    expect(scrollTop).toBe(400);
  });

  it('stops following after keyboard navigation in the transcript', () => {
    render([]);
    const pane = container.querySelector<HTMLElement>('.messages-pane')!;
    setScrollGeometry(pane);
    act(() => pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })));
    scrollTop = 400;
    act(() => pane.dispatchEvent(new Event('scroll')));

    render([{ id: 'a1', role: 'assistant', content: 'New streamed text' }]);
    expect(scrollTop).toBe(400);
  });

  it('keeps settling through delayed height corrections until several stable frames', () => {
    let nextId = 1;
    let height = 1000;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));

    render([]);
    const pane = container.querySelector<HTMLElement>('.messages-pane')!;
    setScrollGeometry(pane);
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => height });
    render([], false);
    render([], true);

    const stepFrame = () => {
      const pending = [...frames.values()];
      frames.clear();
      act(() => pending.forEach((callback) => callback(0)));
    };
    stepFrame();
    height = 1400;
    stepFrame();
    for (let i = 0; i < 4; i++) stepFrame();

    expect(scrollTop).toBe(1400);
    expect(frames.size).toBe(0);
  });
});
