// @vitest-environment jsdom
import fs from 'fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, SessionSyncMsg } from '../../src/sidebar/messageBridge';
import {
  chatMessagesFromSlim,
  conversationPersistedSchema,
  displayPersistMessages,
} from '../../src/sidebar/sessionTypes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } })
  .acquireVsCodeApi = () => ({
  postMessage: (msg: unknown) => posted.push(msg),
});

const fixturePath = process.env['FORGE_REPLAY_FIXTURE'];
const rawFixture = fixturePath
  ? (JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { conversation?: unknown })
  : null;
const conversation = rawFixture
  ? conversationPersistedSchema.parse(rawFixture.conversation)
  : null;
const displayed = conversation
  ? displayPersistMessages(chatMessagesFromSlim(conversation.messages))
  : [];

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

function syncMessage(streaming = false): SessionSyncMsg {
  if (!conversation) throw new Error('FORGE_REPLAY_FIXTURE is required');
  return {
    type: 'sessionSync',
    activeId: conversation.id,
    tabs: [
      {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: displayed.length,
        ...(conversation.active_model ? { active_model: conversation.active_model } : {}),
        ...(streaming ? { streaming: true } : {}),
      },
    ],
    history: [],
    messagesById: { [conversation.id]: displayed },
  };
}

describe.skipIf(!fixturePath)('App saved-session replay', () => {
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
    act(() => hostMessage(syncMessage()));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.removeEventListener('error', onWindowError);
    consoleError.mockRestore();
  });

  function expectNoReactDepthFailure(): void {
    const depthErrors = consoleError.mock.calls.filter((args) =>
      args.some((arg) => String(arg).includes('Maximum update depth exceeded')),
    );
    expect(uncaught).toEqual([]);
    expect(depthErrors).toEqual([]);
  }

  it(
    'hydrates the exact transcript and types/sends the next prompt',
    () => {
      const textarea = container.querySelector<HTMLTextAreaElement>('#prompt')!;
      const savedPrompts = displayed.filter((message) => message.role === 'user');
      const followUp = savedPrompts.at(-1)?.content || 'replay follow-up';

      for (let end = 1; end <= followUp.length; end++) {
        act(() => setNativeTextareaValue(textarea, followUp.slice(0, end)));
      }
      act(() => container.querySelector<HTMLButtonElement>('#btn-send')!.click());

      expectNoReactDepthFailure();
      expect(textarea.value).toBe('');
      expect(posted.some((message) => (message as { type?: string }).type === 'send')).toBe(true);
    },
    60_000,
  );

  it(
    'queues a second prompt while the saved conversation is streaming, then releases it',
    () => {
      act(() => hostMessage({ type: 'generationStarted', conversationId: conversation!.id }));
      const textarea = container.querySelector<HTMLTextAreaElement>('#prompt')!;
      act(() => setNativeTextareaValue(textarea, 'queued replay prompt'));
      act(() => container.querySelector<HTMLButtonElement>('#btn-send')!.click());
      act(() =>
        hostMessage({ type: 'done', finishReason: 'stop', conversationId: conversation!.id }),
      );

      expectNoReactDepthFailure();
      expect(posted.some((message) => (message as { type?: string }).type === 'send')).toBe(true);
    },
    60_000,
  );
});
