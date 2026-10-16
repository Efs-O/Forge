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
  it('keeps the queued message, status, and Cancel in one card', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(
        React.createElement(QueuedPromptRow, {
          text: 'Run the tests after this task.',
          attachmentCount: 1,
          onSendNow: vi.fn(),
          onCancel,
        }),
      );
    });

    expect(container.textContent).toContain('Run the tests after this task.');
    expect(container.textContent).toContain('Sends when this turn ends · 1 attachment');
    const card = container.querySelector('.queued-prompt-card');
    expect(card?.querySelector('.msg.user.msg-queued')?.textContent).toBe('Run the tests after this task.');
    expect(card?.querySelector('.queued-prompt-status')?.textContent).toBe(
      'Sends when this turn ends · 1 attachment',
    );
    const buttons = card?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    expect(Array.from(buttons, (button) => button.textContent)).toEqual(['Send now', 'Cancel']);
    act(() => buttons[1]!.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows the tell label for text-only prompts', () => {
    act(() => {
      root.render(
        React.createElement(QueuedPromptRow, {
          text: 'add a test for perSlotContext',
          attachmentCount: 0,
          tell: true,
          onSendNow: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    expect(container.textContent).toContain('Will reach Forge at its next step');
    expect(container.querySelector('.queued-prompt-card .queued-prompt-status')?.textContent).toBe(
      'Will reach Forge at its next step',
    );
    // A tell sits in the host inbox, and Cancel withdraws it there.
    expect(Array.from(container.querySelectorAll('button'), (b) => b.textContent)).toEqual([
      'Send now',
      'Cancel',
    ]);
  });

  it('sends now once, then says the turn is stopping', () => {
    const onSendNow = vi.fn();
    const render = (sendingNow: boolean) =>
      act(() => {
        root.render(
          React.createElement(QueuedPromptRow, {
            text: 'fix the test first',
            attachmentCount: 0,
            tell: true,
            sendingNow,
            onSendNow,
            onCancel: vi.fn(),
          }),
        );
      });

    render(false);
    const sendNow = container.querySelector<HTMLButtonElement>('button')!;
    expect(sendNow.textContent).toBe('Send now');
    act(() => sendNow.click());
    expect(onSendNow).toHaveBeenCalledOnce();

    render(true);
    expect(container.querySelector('.queued-prompt-status')?.textContent).toBe(
      'Stopping the turn to send this…',
    );
    expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });
});
