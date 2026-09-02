// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { HistoryList } = await import('../../webview-ui/src/components/HistoryList');
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

const ITEMS = [
  { id: 'a', title: 'hello man', createdAt: 1, updatedAt: 2, messageCount: 10 },
  { id: 'b', title: 'second chat', createdAt: 1, updatedAt: 3, messageCount: 7 },
];

interface Handlers {
  onDismiss?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  onRename?: (id: string, title: string) => void;
}

function render(handlers: Handlers = {}, over: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      React.createElement(HistoryList, {
        items: ITEMS,
        expanded: true,
        onDismiss: handlers.onDismiss ?? vi.fn(),
        onRestore: handlers.onRestore ?? vi.fn(),
        onDelete: handlers.onDelete ?? vi.fn(),
        onRename: handlers.onRename ?? vi.fn(),
        ...over,
      }),
    );
  });
}

const kebabs = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.history-item-kebab'));

const menuItems = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.history-menu-item'));

const click = (el: HTMLElement): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const input = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('.history-rename-input');

describe('HistoryList row actions', () => {
  it('keeps the kebab in the DOM without hover so delete is never hover-only', () => {
    render();
    expect(kebabs()).toHaveLength(2);
  });

  it('opens one row menu at a time', () => {
    render();
    click(kebabs()[0]!);
    expect(menuItems().map((b) => b.textContent)).toEqual(['Rename', 'Delete…']);

    click(kebabs()[1]!);
    // Second row replaces the first rather than both standing open.
    expect(container.querySelectorAll('.history-item-menu')).toHaveLength(1);
  });

  it('commits a rename on Enter and closes the editor', () => {
    const onRename = vi.fn();
    render({ onRename });

    click(kebabs()[0]!);
    click(menuItems()[0]!);

    const box = input();
    expect(box).not.toBeNull();
    act(() => {
      box!.value = 'Renamed chat';
      box!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onRename).toHaveBeenCalledWith('a', 'Renamed chat');
    expect(input()).toBeNull();
  });

  it('treats Escape as cancel', () => {
    const onRename = vi.fn();
    render({ onRename });

    click(kebabs()[0]!);
    click(menuItems()[0]!);
    act(() => {
      input()!.value = 'discarded';
      input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it('does not post a rename when the title is unchanged or blank', () => {
    const onRename = vi.fn();
    render({ onRename });

    click(kebabs()[0]!);
    click(menuItems()[0]!);
    act(() => {
      input()!.value = '   ';
      input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onRename).not.toHaveBeenCalled();
  });

  it('delegates delete to the host, which owns the confirmation', () => {
    const onDelete = vi.fn();
    render({ onDelete });

    click(kebabs()[0]!);
    click(menuItems()[1]!);

    expect(onDelete).toHaveBeenCalledWith('a');
  });

  it('restores the conversation when the row body is clicked', () => {
    const onRestore = vi.fn();
    render({ onRestore });

    click(container.querySelector<HTMLButtonElement>('.history-item')!);

    expect(onRestore).toHaveBeenCalledWith('a');
  });
});

describe('sessions panel — overlay contract', () => {
  it('lists closed sessions only — open tabs belong to the strip above', () => {
    render();
    // The panel used to repeat every open tab under an "Open" heading, so the
    // active session rendered twice: once as its own chip, once directly below.
    expect(container.querySelectorAll('.session-section-label')).toHaveLength(0);
    expect(container.querySelectorAll('.history-item')).toHaveLength(ITEMS.length);
  });

  it('dismisses on Escape', () => {
    const onDismiss = vi.fn();
    render({ onDismiss });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses on a click outside, but not on one inside', () => {
    const onDismiss = vi.fn();
    render({ onDismiss });

    act(() => {
      container
        .querySelector('.history-item')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores the toolbar toggle, which owns the other half of the toggle', () => {
    const onDismiss = vi.fn();
    render({ onDismiss });
    const toggle = document.createElement('button');
    toggle.id = 'history-toolbar-btn';
    document.body.appendChild(toggle);

    // Without this the press would both dismiss here and toggle there, so the
    // panel would close and reopen on one click.
    act(() => toggle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onDismiss).not.toHaveBeenCalled();
    toggle.remove();
  });

  it('binds nothing while collapsed', () => {
    const onDismiss = vi.fn();
    render({ onDismiss }, { expanded: false });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
