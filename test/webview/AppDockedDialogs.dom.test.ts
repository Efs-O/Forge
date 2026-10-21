// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: unknown[] = [];
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => posted.push(message) });

const { App } = await import('../../webview-ui/src/App');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;

function hostMessage(message: HostToWebview): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function question(
  id: string,
  conversationId?: string,
  prompt = 'Which reviewer should continue?',
): HostToWebview {
  return {
    type: 'question',
    id,
    prompt,
    ...(conversationId ? { conversationId } : {}),
    specs: [
      {
        prompt,
        multiSelect: false,
        options: [{ label: 'Codex' }, { label: 'Claude' }],
      },
    ],
  };
}

beforeEach(() => {
  posted.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(React.createElement(App)));
  act(() =>
    hostMessage({
      type: 'sessionSync',
      activeId: 'chat-1',
      tabs: [{ id: 'chat-1', title: 'Chat', createdAt: 1, updatedAt: 1 }],
      history: [],
      archived: [],
      waitingIds: [],
      messagesById: {
        'chat-1': [{ role: 'assistant', content: 'Read this context before deciding.' }],
      },
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('App docked agent dialogs', () => {
  it('keeps the transcript scroll pane visible while the question replaces the composer', () => {
    act(() => hostMessage(question('question-1')));

    const transcript = container.querySelector<HTMLElement>('#messages')!;
    expect(transcript.isConnected).toBe(true);
    expect(transcript.classList.contains('messages-pane')).toBe(true);
    expect(transcript.tabIndex).toBe(0);
    expect(transcript.textContent).toContain('Read this context before deciding.');
    expect(container.querySelector('.confirm-overlay')).toBeNull();
    expect(container.querySelector('#composer-area .docked-dialog-panel')).not.toBeNull();
    expect(container.querySelector('.composer-slot')?.hasAttribute('hidden')).toBe(true);
  });

  it('restores the composer draft after answering or skipping a question', () => {
    const prompt = container.querySelector<HTMLTextAreaElement>('#prompt')!;
    act(() => setTextareaValue(prompt, 'keep this draft'));

    act(() => hostMessage(question('question-answer')));
    act(() => container.querySelector<HTMLButtonElement>('.question-option')!.click());
    act(() => container.querySelector<HTMLButtonElement>('.question-answer')!.click());
    act(() => hostMessage({ type: 'questionResolved', id: 'question-answer' }));

    expect(prompt.value).toBe('keep this draft');
    expect(container.querySelector('.composer-slot')?.hasAttribute('hidden')).toBe(false);
    expect(posted).toContainEqual({
      type: 'questionResponse',
      id: 'question-answer',
      kind: 'answer',
      answer: { answers: [{ picks: [0] }] },
    });

    act(() => hostMessage(question('question-dismiss')));
    act(() => container.querySelector<HTMLButtonElement>('.question-skip')!.click());
    act(() => hostMessage({ type: 'questionResolved', id: 'question-dismiss' }));

    expect(prompt.value).toBe('keep this draft');
    expect(container.querySelector('.composer-slot')?.hasAttribute('hidden')).toBe(false);
    expect(posted).toContainEqual({
      type: 'questionResponse',
      id: 'question-dismiss',
      kind: 'skip',
    });
  });

  it('docks approvals, focuses the first control, and preserves question priority order', () => {
    act(() => hostMessage(question('question-pending')));
    act(() =>
      hostMessage({
        type: 'confirmRequest',
        id: 'approval-1',
        toolName: 'write_file',
        detail: 'Update the requested file',
      }),
    );

    let dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.classList.contains('docked-dialog-panel')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('confirmation-dialog-title');
    expect(dialog.hasAttribute('aria-modal')).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('.confirm-btn-deny'));

    act(() => hostMessage({ type: 'confirmResolved', id: 'approval-1' }));
    dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe('question-dialog-title');
    expect(container.querySelector('.composer-slot')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps questions scoped to their conversations and shows the oldest one for the active chat', () => {
    act(() => hostMessage(question('question-oldest', 'chat-1', 'First question?')));
    act(() => hostMessage(question('question-next', 'chat-1', 'Second question?')));
    expect(container.querySelector('.question-prompt')?.textContent).toBe('First question?');

    act(() => hostMessage({ type: 'questionResolved', id: 'question-oldest' }));
    expect(container.querySelector('.question-prompt')?.textContent).toBe('Second question?');

    act(() => hostMessage({ type: 'questionResolved', id: 'question-next' }));
    act(() => hostMessage(question('question-chat-1', 'chat-1', 'Question for chat one?')));
    act(() => hostMessage(question('question-chat-2', 'chat-2', 'Question for chat two?')));
    expect(container.querySelector('.question-prompt')?.textContent).toBe('Question for chat one?');
    expect(container.querySelector('.composer-slot')?.hasAttribute('hidden')).toBe(true);

    act(() =>
      hostMessage({
        type: 'sessionSync',
        activeId: 'chat-2',
        tabs: [
          { id: 'chat-1', title: 'One', createdAt: 1, updatedAt: 1 },
          { id: 'chat-2', title: 'Two', createdAt: 2, updatedAt: 2 },
        ],
        history: [],
        archived: [],
        waitingIds: [],
        messagesById: {
          'chat-1': [{ role: 'assistant', content: 'One' }],
          'chat-2': [{ role: 'assistant', content: 'Two' }],
        },
      }),
    );
    expect(container.querySelector('.question-prompt')?.textContent).toBe('Question for chat two?');
    expect(container.querySelector('.question-docked-panel')).not.toBeNull();
  });

  it('preserves question picks and notes while an approval pre-empts the card', () => {
    act(() => hostMessage(question('question-draft')));
    act(() => container.querySelector<HTMLButtonElement>('.question-option')!.click());
    const note = container.querySelector<HTMLTextAreaElement>('.question-note')!;
    act(() => setTextareaValue(note, 'keep this choice'));
    act(() =>
      hostMessage({
        type: 'confirmRequest',
        id: 'approval-over-question',
        toolName: 'write_file',
        detail: 'Update the requested file',
      }),
    );
    act(() => hostMessage({ type: 'confirmResolved', id: 'approval-over-question' }));

    expect(
      container.querySelector<HTMLButtonElement>('.question-option')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(container.querySelector<HTMLTextAreaElement>('.question-note')?.value).toBe(
      'keep this choice',
    );
  });

  it('does not move focus from the composer when a question arrives while typing', () => {
    const prompt = container.querySelector<HTMLTextAreaElement>('#prompt')!;
    act(() => prompt.focus());
    act(() => hostMessage(question('question-while-typing')));

    expect(document.activeElement).not.toBe(container.querySelector('.question-docked-panel'));
  });

  it('keeps Escape available for confirmation and denies the pending approval', () => {
    act(() =>
      hostMessage({
        type: 'confirmRequest',
        id: 'approval-escape',
        toolName: 'shell',
        detail: 'Run the command',
      }),
    );
    act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );

    expect(posted).toContainEqual({
      type: 'confirmResponse',
      id: 'approval-escape',
      approved: false,
    });
    expect(container.querySelector('.composer-slot')?.hasAttribute('hidden')).toBe(false);
  });

  it('posts approve and deny responses and explains the dangerous action', () => {
    act(() =>
      hostMessage({
        type: 'confirmRequest',
        id: 'approval-dangerous',
        toolName: 'delete_file',
        detail: 'Delete the requested file',
        isDangerous: true,
      }),
    );
    expect(container.querySelector('.confirm-tool-name')?.textContent).toContain(
      '⚠ DANGEROUS: delete_file',
    );
    expect(container.querySelector('.confirm-btn-approve')?.textContent).toBe(
      'Run (I understand the risk)',
    );
    act(() => container.querySelector<HTMLButtonElement>('.confirm-btn-approve')!.click());
    expect(posted).toContainEqual({
      type: 'confirmResponse',
      id: 'approval-dangerous',
      approved: true,
    });

    act(() =>
      hostMessage({
        type: 'confirmRequest',
        id: 'approval-denied',
        toolName: 'write_file',
        detail: 'Write the requested file',
      }),
    );
    act(() => container.querySelector<HTMLButtonElement>('.confirm-btn-deny')!.click());
    expect(posted).toContainEqual({
      type: 'confirmResponse',
      id: 'approval-denied',
      approved: false,
    });
  });

  it('leaves the approval pending when Escape belongs to a field outside the panel', () => {
    act(() =>
      hostMessage({
        type: 'confirmRequest',
        id: 'approval-rename',
        toolName: 'shell',
        detail: 'Run the command',
      }),
    );
    // The dialog is not modal, so the user can be renaming a chat meanwhile.
    const field = document.createElement('input');
    container.prepend(field);
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    expect(posted.some((message) => message.type === 'confirmResponse')).toBe(false);
    expect(container.querySelector('.docked-dialog-panel')).not.toBeNull();
  });
});
