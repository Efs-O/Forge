// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ChatHeader } = await import('../../webview-ui/src/components/ChatHeader');
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

function render(onRename?: (title: string) => void): void {
  act(() => {
    root.render(
      React.createElement(ChatHeader, {
        title: 'hello man',
        historyExpanded: false,
        onNew: vi.fn(),
        onToggleHistory: vi.fn(),
        onRename,
      }),
    );
  });
}

const title = (): HTMLElement | null => container.querySelector('#chat-header-title');
const input = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('#chat-header-title-input');

function edit(value: string, key: string): void {
  act(() => title()!.click());
  act(() => {
    input()!.value = value;
    input()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('ChatHeader title rename', () => {
  it('renames the chat when the clicked title is edited and Enter pressed', () => {
    const onRename = vi.fn();
    render(onRename);
    edit('Renamed chat', 'Enter');
    expect(onRename).toHaveBeenCalledWith('Renamed chat');
    expect(input()).toBeNull();
  });

  it.each([
    ['Escape', 'discarded'],
    ['Enter', '   '],
    ['Enter', 'hello man'],
  ])('does not rename on %s with %j', (key, value) => {
    const onRename = vi.fn();
    render(onRename);
    edit(value, key);
    expect(onRename).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it('is plain text when there is no conversation to rename', () => {
    render(undefined);
    expect(title()!.tagName).toBe('SPAN');
    act(() => title()!.click());
    expect(input()).toBeNull();
  });
});
