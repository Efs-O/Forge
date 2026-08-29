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
  onSwitch?: (id: string) => void;
  onRestore?: () => void;
  onDelete?: () => void;
  onRename?: (id: string, title: string) => void;
}

const OPEN_TABS = [
  { id: 'open-1', title: 'refactor ConfigLoader', createdAt: 1, updatedAt: 9, messageCount: 12 },
  { id: 'open-2', title: 'write tests', createdAt: 1, updatedAt: 8, messageCount: 3 },
];

function render(handlers: Handlers = {}, over: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      React.createElement(HistoryList, {
        items: ITEMS,
        tabs: [],
        activeId: 'open-1',
        streamingIds: new Set<string>(),
        queuedIds: new Set<string>(),
        expanded: true,
        onSwitch: handlers.onSwitch ?? vi.fn(),
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

describe('sessions panel — open section', () => {
  it('lists open tabs above the closed ones and switches on click', () => {
    const onSwitch = vi.fn();
    render({ onSwitch }, { tabs: OPEN_TABS, activeId: 'open-1' });

    const labels = Array.from(
      container.querySelectorAll('.session-section-label'),
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Open', 'Closed']);

    const openRows = container.querySelectorAll('.session-list .history-item');
    expect(Array.from(openRows, (el) => el.textContent)).toEqual([
      expect.stringContaining('refactor ConfigLoader'),
      expect.stringContaining('write tests'),
    ]);

    act(() => (openRows[1] as HTMLButtonElement).click());
    expect(onSwitch).toHaveBeenCalledWith('open-2');
  });

  it('marks the active tab without hiding it from the list', () => {
    render({}, { tabs: OPEN_TABS, activeId: 'open-2' });
    const current = container.querySelectorAll('.history-item-row-current');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain('write tests');
  });

  it('shows the spinner for a streaming tab and the dot for a queued one', () => {
    render(
      {},
      {
        tabs: OPEN_TABS,
        activeId: 'open-1',
        streamingIds: new Set(['open-1']),
        queuedIds: new Set(['open-2']),
      },
    );
    const rows = container.querySelectorAll('.session-list .history-item-row');
    expect(rows[0]!.querySelector('.tab-streaming-spinner')).not.toBeNull();
    expect(rows[0]!.querySelector('.tab-waiting-dot')).toBeNull();
    expect(rows[1]!.querySelector('.tab-waiting-dot')).not.toBeNull();
  });

  it('gives open rows no kebab — an open tab is closed from the strip', () => {
    render({}, { tabs: OPEN_TABS, activeId: 'open-1' });
    expect(container.querySelectorAll('.session-list .history-item-kebab')).toHaveLength(0);
  });

  it('keeps element ids unique across both sections', () => {
    // Both sections share a wrapper, so it is a class: two elements carrying
    // one id is invalid and makes getElementById order-dependent.
    render({}, { tabs: OPEN_TABS, activeId: 'open-1' });
    const ids = Array.from(container.querySelectorAll('[id]'), (el) => el.id);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(container.querySelectorAll('.history-list-wrap')).toHaveLength(2);
  });
});
