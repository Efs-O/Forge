// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppMessage } from '../../webview-ui/src/messageOps';
import type { ActivityViewMode } from '../../webview-ui/src/activityRows';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: () => undefined,
});
const React = await import('react');
const { MessageList } = await import('../../webview-ui/src/components/MessageList');
const { TranscriptPanes } = await import('../../webview-ui/src/components/TranscriptPanes');
const { initialState } = await import('../../webview-ui/src/appState');

let container: HTMLDivElement;
let root: Root;
const messages = (count: number): AppMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: 'assistant',
    content: `Reply ${index}`,
  }));
const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-transcript-row]'));
const earlier = () => container.querySelector<HTMLButtonElement>('.transcript-earlier');
function render(items: AppMessage[], mode: ActivityViewMode = 'full'): void {
  act(() =>
    root.render(
      React.createElement(MessageList, {
        messages: items,
        conversationId: 'chat',
        active: true,
        streaming: true,
        activityView: mode,
        thinkingDisplay: 'preview',
        queuedPrompts: [],
        onCancelQueuedPrompt: () => undefined,
        onSendQueuedPromptNow: () => undefined,
      }),
    ),
  );
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('transcript paging', () => {
  it('mounts only the last 100 of 10,000 messages and rolls the tail during streaming', () => {
    const items = messages(10000);
    render(items);
    expect(rows()).toHaveLength(100);
    expect(rows()[0]!.dataset.transcriptRow).toBe('m9900');
    expect(earlier()!.textContent).toContain('9900 earlier');
    render([...items, { id: 'new', role: 'assistant', content: 'Streaming tail' }]);
    expect(rows()).toHaveLength(100);
    expect(rows()[0]!.dataset.transcriptRow).toBe('m9901');
    expect(rows().at(-1)!.textContent).toContain('Streaming tail');
    expect(items).toHaveLength(10000);
  });

  it('reveals every earlier batch in order, including a partial final page', () => {
    render(messages(250));
    act(() => earlier()!.click());
    expect(rows()).toHaveLength(200);
    expect(rows()[0]!.dataset.transcriptRow).toBe('m50');
    act(() => earlier()!.click());
    expect(rows().map((row) => row.dataset.transcriptRow)).toEqual(messages(250).map((m) => m.id));
    expect(earlier()).toBeNull();
  });

  it('preserves a prepended viewport, holds it during streaming, and bounds it again at the bottom', () => {
    const items = messages(250);
    render(items);
    const pane = container.querySelector<HTMLElement>('.messages-pane')!;
    let top = 80;
    const height = () => rows().length * 40 + (earlier() ? 40 : 0);
    Object.defineProperties(pane, {
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
        },
      },
      scrollHeight: { configurable: true, get: height },
      clientHeight: { configurable: true, get: () => 300 },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const index = rows().indexOf(this as HTMLElement);
      const y = index < 0 ? 0 : index * 40 + (earlier() ? 40 : 0) - top;
      return { top: y, bottom: y + 40 } as DOMRect;
    });
    const anchor = rows()[1]!;
    const previous = anchor.getBoundingClientRect().top;
    act(() => earlier()!.click());
    expect(anchor.isConnected).toBe(true);
    expect(anchor.getBoundingClientRect().top).toBe(previous);
    const readingTop = top;
    render([...items, { id: 'new', role: 'assistant', content: 'New tail' }]);
    expect(rows()).toHaveLength(201);
    expect(top).toBe(readingTop);
    top = height() - 300;
    act(() => pane.dispatchEvent(new Event('scroll')));
    expect(rows()).toHaveLength(100);
    expect(top).toBe(height()); // jsdom doesn't clamp scrollTop; the browser does.
  });

  it('caps a held window, reports newer messages, and jumps to the latest tail on request', () => {
    render(messages(150));
    const pane = container.querySelector<HTMLElement>('.messages-pane')!;
    Object.defineProperties(pane, {
      scrollHeight: { configurable: true, get: () => rows().length * 40 },
      clientHeight: { configurable: true, get: () => 300 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    act(() => pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
    const holdCount = rows().length;
    render(messages(600));
    expect(rows().length).toBeLessThanOrEqual(300 + holdCount);
    const newer = container.querySelector<HTMLButtonElement>('.transcript-newer')!;
    expect(newer.textContent).toBe('Show latest messages (250 newer)');
    act(() => newer.click());
    expect(rows()).toHaveLength(100);
    expect(rows().at(-1)!.dataset.transcriptRow).toBe('m599');
  });

  it('follows the tail when held without newer messages, but keeps the cap at its bottom', () => {
    const items = messages(150);
    render(items);
    const pane = container.querySelector<HTMLElement>('.messages-pane')!;
    let top = 0;
    Object.defineProperties(pane, {
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
      scrollHeight: { configurable: true, get: () => rows().length * 40 },
      clientHeight: { configurable: true, get: () => 300 },
    });
    act(() => pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
    render([...items, { id: 'm150', role: 'assistant', content: 'New tail' }]);
    expect(container.querySelector('.transcript-newer')).toBeNull();
    top = pane.scrollHeight - pane.clientHeight;
    act(() => pane.dispatchEvent(new Event('scroll')));
    expect(rows()).toHaveLength(100);
    expect(rows().at(-1)!.dataset.transcriptRow).toBe('m150');

    render(messages(150));
    act(() => pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
    render(messages(600));
    const cappedCount = rows().length;
    expect(container.querySelector('.transcript-newer')?.textContent).toBe(
      'Show latest messages (250 newer)',
    );
    top = pane.scrollHeight - pane.clientHeight;
    act(() => pane.dispatchEvent(new Event('scroll')));
    expect(rows()).toHaveLength(cappedCount);
    expect(container.querySelector('.transcript-newer')).not.toBeNull();
  });

  it.each(['full', 'compact', 'grouped'] as const)(
    'pages before folding in %s view and keeps existing groups mounted',
    (mode) => {
      const tools: AppMessage[] = Array.from({ length: 300 }, (_, index) => ({
        id: `t${index}`,
        role: 'tool',
        content: `Result ${index}`,
        toolName: 'read_file',
        toolCallId: `call-${index}`,
        toolTarget: `file-${index}`,
        toolResultTotal: 10,
      }));
      render(tools, mode);
      const old = rows()[0]!;
      expect(old.dataset.transcriptRow).toBe('t200');
      expect(earlier().textContent).toContain('200 earlier');
      act(() => earlier()!.click());
      expect(old.isConnected).toBe(true);
      expect(earlier().textContent).toContain('100 earlier');
      act(() => earlier()!.click());
      expect(earlier()).toBeNull();
      expect(rows().some((row) => row.dataset.transcriptRow === 't0')).toBe(true);
    },
  );

  it('falls back to the bounded tail when a host reset removes the pinned message', () => {
    render(messages(500));
    act(() => earlier()!.click());
    render([{ id: 'reset', role: 'user', content: 'New conversation state' }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.dataset.transcriptRow).toBe('reset');
    expect(earlier()).toBeNull();
  });

  it.each(['full', 'compact', 'grouped'] as const)(
    'keeps pending calls and queued prompts outside paging in %s view',
    (mode) => {
      act(() =>
        root.render(
          React.createElement(MessageList, {
            messages: messages(1000),
            conversationId: 'chat',
            active: true,
            streaming: true,
            activityView: mode,
            thinkingDisplay: 'preview',
            resumedNote: 'Resumed chat',
            queuedPrompts: [{ id: 'q', text: 'Queued instruction', attachments: [] }],
            pendingToolCalls: [
              {
                index: 0,
                toolName: 'write_file',
                target: 'result.ts',
                tokens: 5,
                startedAt: Date.now(),
              },
            ],
            onCancelQueuedPrompt: () => undefined,
            onSendQueuedPromptNow: () => undefined,
          }),
        ),
      );
      expect(rows()).toHaveLength(100);
      expect(container.textContent).toContain('Queued instruction');
      expect(container.textContent).toContain('write_file');
      expect(container.textContent).toContain('result.ts');
      expect(container.textContent).toContain('Resumed chat');
    },
  );

  it('releases inactive panes and resets a revisited transcript to its recent tail', () => {
    const renderTab = (activeConversationId: string) =>
      act(() =>
        root.render(
          React.createElement(TranscriptPanes, {
            state: {
              ...initialState,
              activeConversationId,
              messagesById: { a: messages(300), b: messages(400) },
            },
            queuedPrompts: [],
            resumedIds: new Set<string>(),
            emptyState: null,
            onCancelQueuedPrompt: () => undefined,
            onSendQueuedPromptNow: () => undefined,
          }),
        ),
      );
    renderTab('a');
    act(() => earlier()!.click());
    const old = rows()[0]!;
    expect(rows()).toHaveLength(200);
    renderTab('b');
    expect(old.isConnected).toBe(false);
    expect(container.querySelectorAll('.messages-pane')).toHaveLength(1);
    expect(rows()).toHaveLength(100);
    renderTab('a');
    expect(rows()).toHaveLength(100);
    expect(rows()[0]!.dataset.transcriptRow).toBe('m200');
  });
});
