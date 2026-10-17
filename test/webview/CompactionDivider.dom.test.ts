// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import type { SessionSyncMsg } from '../../src/sidebar/messageBridge';
import { displayTranscriptRows } from '../../src/sidebar/sessionProjections';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined,
});

const messages: ChatMessage[] = [
  { role: 'user', content: 'first task' },
  { role: 'assistant', content: 'first result' },
  { role: 'user', content: 'second task' },
  { role: 'assistant', content: 'second result' },
];
const displayed = displayTranscriptRows(messages, [], {
  summary: 'second result is complete',
  fromIndex: 4,
  generation: 2,
  dividers: [
    { generation: 1, fromIndex: 2, source: 'auto' },
    { generation: 2, fromIndex: 4, source: 'manual' },
  ],
});
const sync: SessionSyncMsg = {
  type: 'sessionSync',
  activeId: 'chat-1',
  tabs: [
    { id: 'chat-1', title: 'Chat', createdAt: 1, updatedAt: 2, messageCount: displayed.length },
  ],
  history: [],
  archived: [],
  waitingIds: [],
  messagesById: { 'chat-1': displayed },
};

const { App } = await import('../../webview-ui/src/App');
const React = await import('react');

describe('compaction divider webview replay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(App)));
    act(() => window.dispatchEvent(new MessageEvent('message', { data: sync })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders restored divider rows between the messages at each compaction boundary', () => {
    const transcript = container.querySelector('#messages')!;
    const text = transcript.textContent ?? '';
    const firstResult = text.indexOf('first result');
    const firstDivider = text.indexOf('Context compacted · generation 1 · auto');
    const secondTask = text.indexOf('second task');
    const secondDivider = text.indexOf('Context compacted · generation 2 · manual');

    expect(firstResult).toBeGreaterThanOrEqual(0);
    expect(firstResult).toBeLessThan(firstDivider);
    expect(firstDivider).toBeLessThan(secondTask);
    expect(secondDivider).toBeGreaterThan(text.indexOf('second result'));
  });
});
