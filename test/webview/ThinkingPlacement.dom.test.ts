// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { MessageList } = await import('../../webview-ui/src/components/MessageList');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetDisclosures();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('places each thinking block in the main flow before the collapsed tool group', () => {
  const messages: AppMessage[] = [
    { id: 'commentary', role: 'assistant', content: 'I will inspect the file.' },
    {
      id: 'thought',
      role: 'assistant',
      content: '',
      reasoning: 'check the existing implementation first',
      reasoningMs: 1_000,
    },
    {
      id: 'tool',
      role: 'tool',
      content: 'read_file',
      toolName: 'read_file',
      toolTarget: 'src/example.ts',
      toolResult: 'read complete',
      toolResultTotal: 13,
    },
    {
      id: 'answer',
      role: 'assistant',
      content: 'The file is ready.',
      reasoning: 'confirm the result before replying',
      reasoningMs: 500,
      createdAt: Date.now(),
    },
  ];

  act(() => {
    root.render(
      React.createElement(MessageList, {
        messages,
        queuedPrompts: [],
        onCancelQueuedPrompt: () => undefined,
        onSendQueuedPromptNow: () => undefined,
        streaming: false,
        conversationId: 'chat-1',
        active: true,
        activityView: 'grouped',
        thinkingDisplay: 'preview',
      }),
    );
  });

  const pane = container.querySelector('.messages-pane')!;
  const rows = [...pane.children];
  expect(rows.map((row) => row.className)).toEqual([
    'msg-wrapper msg-wrapper-assistant',
    'thinking-block',
    'activity-group',
    'thinking-block',
    'msg-wrapper msg-wrapper-assistant',
    '',
  ]);
  expect(rows[1]?.textContent).toContain('check the existing implementation first');
  expect(rows[2]?.querySelector('.activity-group-body')).toBeNull();
  expect(rows[2]?.querySelector('.thinking-block')).toBeNull();
  expect(rows[3]?.textContent).toContain('confirm the result before replying');
  expect(rows[4]?.textContent).toContain('The file is ready.');
  expect(rows[4]?.querySelector('time.message-timestamp')).not.toBeNull();
  expect(rows[4]?.querySelector('.folded-content-toggle')).toBeNull();
});
