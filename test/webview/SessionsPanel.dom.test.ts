// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } })
  .acquireVsCodeApi = () => ({
  postMessage: (msg: unknown) => posted.push(msg),
});

const { App } = await import('../../webview-ui/src/App');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;

const NOW = Date.now();

function hostMessage(message: HostToWebview): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

/** Two open tabs plus one closed conversation, so both panel sections render. */
function sync(): HostToWebview {
  return {
    type: 'sessionSync',
    activeId: 'tab-1',
    tabs: [
      { id: 'tab-1', title: 'first', createdAt: NOW, updatedAt: NOW, messageCount: 2 },
      { id: 'tab-2', title: 'second', createdAt: NOW, updatedAt: NOW, messageCount: 3 },
    ],
    history: [{ id: 'old-1', title: 'archived', createdAt: 1, updatedAt: 2, messageCount: 4 }],
    messagesById: { 'tab-1': [], 'tab-2': [] },
  };
}

function panel(): HTMLElement {
  const el = container.querySelector<HTMLElement>('#history-panel');
  if (!el) throw new Error('panel not rendered');
  return el;
}

function toggle(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('#history-toolbar-btn');
  if (!el) throw new Error('toggle not rendered');
  return el;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function openPanel(): void {
  click(toggle());
  expect(panel().hidden).toBe(false);
}

beforeEach(() => {
  posted.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(React.createElement(App)));
  act(() => hostMessage(sync()));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('sessions panel dismissal', () => {
  it('switches sessions from the strip, not from the panel', () => {
    // The panel lists closed sessions only now. Open tabs were listed in both
    // places, so the active session rendered twice - once as its chip above,
    // once as a row below it.
    openPanel();
    expect(panel().querySelectorAll('.session-list')).toHaveLength(0);

    const chips = container.querySelectorAll<HTMLButtonElement>('.tab-chip-label');
    expect(chips.length).toBe(2);
    click(chips[1]!);
    expect(posted).toContainEqual({ type: 'switchConversation', id: 'tab-2' });
  });

  it('dismisses on Escape without touching the session', () => {
    openPanel();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(panel().hidden).toBe(true);
    expect(posted).not.toContainEqual(
      expect.objectContaining({ type: 'switchConversation' } as Record<string, unknown>),
    );
  });

  it('collapses after restoring a closed session', () => {
    openPanel();
    const restore = panel().querySelector<HTMLButtonElement>('#history-list .history-item');
    if (!restore) throw new Error('closed row not rendered');
    click(restore);

    expect(posted).toContainEqual({ type: 'restoreConversation', id: 'old-1' });
    expect(panel().hidden).toBe(true);
  });

  it('returns focus to the toggle, so keyboard users do not land on <body>', () => {
    openPanel();
    const restore = panel().querySelector<HTMLButtonElement>('#history-list .history-item');
    if (!restore) throw new Error('closed row not rendered');
    click(restore);

    expect(document.activeElement).toBe(toggle());
  });

  it('leaves the panel open when a row is only renamed', () => {
    // Management, not navigation: walking down the list must survive it.
    openPanel();
    const kebab = panel().querySelector<HTMLButtonElement>('#history-list .history-item-kebab');
    if (!kebab) throw new Error('kebab not rendered');
    click(kebab);
    const rename = Array.from(panel().querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.startsWith('Rename'),
    );
    if (!rename) throw new Error('rename not rendered');
    click(rename);

    expect(panel().hidden).toBe(false);
  });

  it('does not steal focus when the panel is collapsed by the toggle itself', () => {
    openPanel();
    toggle().focus();
    click(toggle());

    expect(panel().hidden).toBe(true);
    // Refocusing here would be harmless but wrong: nothing selected a session.
    expect(document.activeElement).toBe(toggle());
  });
});
