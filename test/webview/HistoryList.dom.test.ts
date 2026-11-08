// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PANEL_WIDTH } from '../../src/sidebar/historyPanelSize';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The panel now talks to the host: it posts the size when the grip moves. The
// webview's `vscode` module calls `acquireVsCodeApi` the moment it is imported,
// so the stub has to exist before this file's dynamic import of the component.
const posted: unknown[] = [];
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: (msg: unknown) => posted.push(msg) });

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
  { id: 'a', title: 'hello man', createdAt: 1, updatedAt: 3, messageCount: 10 },
  { id: 'b', title: 'second chat', createdAt: 1, updatedAt: 2, messageCount: 7 },
];

interface Handlers {
  onDismiss?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  onRename?: (id: string, title: string) => void;
  onResetApprovals?: (id: string) => void;
  onSetKeepOpen?: (id: string, keepOpen: boolean) => void;
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
        onResetApprovals: handlers.onResetApprovals ?? vi.fn(),
        onSetKeepOpen: handlers.onSetKeepOpen ?? vi.fn(),
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

/** The three sections are tabs now, so a test that wants a list has to ask for
 *  the tab that owns it. Only the selected tab's rows are in the DOM. */
const tabButton = (id: 'chats' | 'archived' | 'jobs'): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`#history-tab-${id}`)!;
const openTab = (id: 'chats' | 'archived' | 'jobs'): void => click(tabButton(id));
/** Closed chats — recent history and the overflow past it — live under
 *  Archived; Chats holds only what is open as a tab. */
function renderClosed(handlers: Handlers = {}, over: Record<string, unknown> = {}): void {
  render(handlers, over);
  openTab('archived');
}
const tabLabels = (): string[] =>
  Array.from(container.querySelectorAll('.history-tab-label')).map((el) => el.textContent ?? '');
/** The badge beside each tab name, in the same order. */
const tabCounts = (): string[] =>
  Array.from(container.querySelectorAll('.history-tab')).map((el) => el.textContent ?? '');

/** Typing into the search box. The input is controlled, so `.value` alone is
 *  not enough: React reads the element's own value, and the native setter is
 *  what makes the next render see the change. */
function setValue(value: string): void {
  const box = container.querySelector<HTMLInputElement>('#history-search')!;
  const setter = Object.getOwnPropertyDescriptor!(window.HTMLInputElement.prototype, 'value').set!;
  act(() => {
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const input = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('.history-rename-input');

describe('HistoryList row actions', () => {
  it('hides legacy copies by default but can reveal and restore them without deleting anything', () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const props = {
      items: [ITEMS[0], { ...ITEMS[1], legacy_global: true }],
      archived: [
        {
          id: 'legacy-overflow',
          title: 'old shared chat',
          createdAt: 1,
          updatedAt: 1,
          legacy_global: true,
        },
      ],
    };
    renderClosed({ onRestore, onDelete }, props);
    expect(tabButton('archived').textContent).toContain('1');
    expect(container.querySelectorAll('#history-list .history-item')).toHaveLength(1);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.parentElement?.textContent).toContain('Include legacy chats (2)');
    click(checkbox);
    expect(tabButton('archived').textContent).toContain('3');
    const rows = container.querySelectorAll<HTMLButtonElement>('#history-list .history-item');
    expect(rows).toHaveLength(3);
    click(rows[1]!);
    expect(onRestore).toHaveBeenCalledWith('b');
    expect(onDelete).not.toHaveBeenCalled();
    render({ onRestore, onDelete }, { ...props, expanded: false });
    renderClosed({ onRestore, onDelete }, props);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
      false,
    );
    expect(container.querySelectorAll('#history-list .history-item')).toHaveLength(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('lists every closed chat, recent and overflow, under Archived and none under Chats', () => {
    render({}, { archived: [{ id: 'old', title: 'old chat', createdAt: 1, updatedAt: 1 }] });
    const toggle = container.querySelector<HTMLButtonElement>('#history-tab-archived');
    expect(toggle?.textContent).toContain('3');
    expect(container.querySelector('#history-list')).toBeNull();
    click(toggle!);
    const titles = Array.from(container.querySelectorAll('#history-list .history-item-title')).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(['hello man', 'second chat', 'old chat']);
  });

  it('draws a chat once when it is briefly both recent and overflow', () => {
    renderClosed({}, { archived: [{ ...ITEMS[0]!, updatedAt: 1 }] });
    expect(container.querySelectorAll('#history-list .history-item')).toHaveLength(ITEMS.length);
  });

  it('keeps the kebab in the DOM without hover so delete is never hover-only', () => {
    renderClosed();
    expect(kebabs()).toHaveLength(2);
  });

  it('opens one row menu at a time', () => {
    renderClosed();
    click(kebabs()[0]!);
    expect(menuItems().map((b) => b.textContent)).toEqual(['Rename', 'Reset approvals', 'Delete…']);

    click(kebabs()[1]!);
    // Second row replaces the first rather than both standing open.
    expect(container.querySelectorAll('.history-item-menu')).toHaveLength(1);
  });

  it('commits a rename on Enter and closes the editor', () => {
    const onRename = vi.fn();
    renderClosed({ onRename });

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
    renderClosed({ onRename });

    click(kebabs()[0]!);
    click(menuItems()[0]!);
    act(() => {
      input()!.value = 'discarded';
      input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it.each([
    ['unchanged', 'hello man'],
    ['blank', '   '],
  ])('does not post a rename when the title is %s', (_caseName, title) => {
    const onRename = vi.fn();
    renderClosed({ onRename });

    click(kebabs()[0]!);
    click(menuItems()[0]!);
    act(() => {
      input()!.value = title;
      input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onRename).not.toHaveBeenCalled();
  });

  it('delegates delete to the host, which owns the confirmation', () => {
    const onDelete = vi.fn();
    renderClosed({ onDelete });

    click(kebabs()[0]!);
    click(menuItems()[2]!);

    expect(onDelete).toHaveBeenCalledWith('a');
  });

  it('resets approvals for the selected chat', () => {
    const onResetApprovals = vi.fn();
    renderClosed({ onResetApprovals });

    click(kebabs()[0]!);
    click(menuItems()[1]!);

    expect(onResetApprovals).toHaveBeenCalledWith('a');
  });

  it('restores the conversation when the row body is clicked', () => {
    const onRestore = vi.fn();
    renderClosed({ onRestore });

    click(container.querySelector<HTMLButtonElement>('.history-item')!);

    expect(onRestore).toHaveBeenCalledWith('a');
  });

  it('toggles Keep open directly without switching the chat, and exposes the persistent pin state', () => {
    const onSwitchOpen = vi.fn();
    const onSetKeepOpen = vi.fn();
    render(
      { onSetKeepOpen },
      {
        openItems: [{ ...ITEMS[0]!, keep_open: true }],
        onSwitchOpen,
      },
    );
    const pin = container.querySelector<HTMLButtonElement>('.history-item-keep-open')!;
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(pin.getAttribute('aria-label')).toBe('Allow auto-archive for hello man');
    click(pin);
    expect(onSetKeepOpen).toHaveBeenCalledWith('a', false);
    expect(onSwitchOpen).not.toHaveBeenCalled();
  });

  it('renders sender, title and status in shared columns for open and archived chats', () => {
    render({}, { openItems: [{ ...ITEMS[0]!, keep_open: false }] });
    const open = container.querySelector('#history-open-list .history-chat-item')!;
    expect(open.querySelector('.history-item-sender .history-row-badge')?.textContent).toBe('You');
    expect(open.querySelector('.history-item-title')?.textContent).toBe('hello man');
    expect(open.querySelector('.history-item-status')?.textContent).toContain('Open');
    openTab('archived');
    const archived = container.querySelector('#history-list .history-chat-item')!;
    expect(archived.querySelector('.history-item-sender .history-row-badge')?.textContent).toBe(
      'You',
    );
    expect(archived.querySelector('.history-item-title')?.textContent).toBe('hello man');
    expect(container.querySelector('.history-tab-count--archived')).not.toBeNull();
    expect(container.querySelector('.history-tab-count--chats')).not.toBeNull();
    const rowsCss = readFileSync('webview-ui/styles/history-rows.css', 'utf8');
    expect(rowsCss).toContain('grid-template-columns: 60px minmax(0, 1fr) max-content;');
    expect(rowsCss).toContain('padding: 4px;');
    expect(rowsCss).toContain('grid-template-columns: 56px minmax(0, 1fr) auto;');
  });
});

describe('sessions panel — overlay contract', () => {
  it('lists archived sessions when there are no open sessions', () => {
    renderClosed();
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
    renderClosed({ onDismiss });

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

describe('sessions panel — open rows hold still', () => {
  const tab = (id: string, updatedAt: number) => ({
    id,
    title: `chat ${id}`,
    createdAt: 1,
    updatedAt,
  });
  const openTitles = (): string[] =>
    Array.from(container.querySelectorAll('#history-open-list .history-item-title')).map(
      (el) => el.textContent ?? '',
    );

  it('keeps the order it opened with while two chats trade updatedAt, and re-sorts on reopen', () => {
    render({}, { openItems: [tab('a', 5), tab('b', 4)] });
    expect(openTitles()).toEqual(['chat a', 'chat b']);
    // b streams and becomes the most recent: App hands the list over re-sorted.
    render({}, { openItems: [tab('b', 6), tab('a', 5)] });
    expect(openTitles()).toEqual(['chat a', 'chat b']);
    render({}, { openItems: [tab('c', 7), tab('b', 6), tab('a', 5)] });
    expect(openTitles()).toEqual(['chat c', 'chat a', 'chat b']);
    render({}, { expanded: false, openItems: [tab('b', 6), tab('c', 7), tab('a', 5)] });
    render({}, { openItems: [tab('b', 8), tab('c', 7), tab('a', 5)] });
    expect(openTitles()).toEqual(['chat b', 'chat c', 'chat a']);
  });
});

describe('sessions panel — jobs section', () => {
  const jobRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: `job ${id}`,
    schedule: 'daily at 08:20',
    enabled: true,
    description: `Job "job ${id}" [${id}]`,
    lastOutcomeLabel: 'no runs yet',
    lastRun: null,
    runningConversationId: null,
    ...over,
  });
  const tab = (id: string, updatedAt: number) => ({
    id,
    title: `chat ${id}`,
    createdAt: 1,
    updatedAt,
  });
  const openTitles = (): string[] =>
    Array.from(container.querySelectorAll('#history-open-list .history-item-title')).map(
      (el) => el.textContent ?? '',
    );
  const jobTitles = (): string[] =>
    Array.from(container.querySelectorAll('#history-jobs-list .history-item-title')).map(
      (el) => el.textContent ?? '',
    );
  const jobMetas = (index: number): string[] =>
    Array.from(
      container
        .querySelectorAll('#history-jobs-list .history-item-row')
        [index]!.querySelectorAll('.history-item-meta'),
    ).map((el) => el.textContent ?? '');

  it('shows the Jobs section even with no conversations and no jobs', () => {
    render({}, { items: [], openItems: [], jobs: [], jobsLoaded: true });
    // The section names live in the tab strip now, not in a heading inside each
    // scroll box: `Jobs` is a tab you can switch to, not a caption below the fold.
    const headings = tabLabels();
    expect(headings).toContain('Jobs');
    expect(container.querySelector('#history-empty')?.textContent).toBe('No open chats.');
    openTab('jobs');
    expect(container.querySelector('#history-jobs-empty')?.textContent).toBe('No jobs yet.');
    // The conversations empty state is its own text: jobs do not replace it.
  });

  it('says a panel is loading until the host has answered it', () => {
    render({}, { items: [], openItems: [], jobs: [], jobsLoaded: false });
    openTab('jobs');
    expect(container.querySelector('#history-jobs-empty')?.textContent).toBe('Loading jobs…');
  });

  it('names each job with its schedule, its paused state, and its last run', () => {
    render(
      {},
      {
        jobs: [
          jobRow('a'),
          jobRow('b', { enabled: false }),
          jobRow('c', {
            lastRun: {
              at: Date.now() - 2 * 3_600_000,
              outcome: 'failed',
              detail: 'the /unload patch does not apply',
            },
            lastOutcomeLabel: 'failing ×3',
            consecutiveFailures: 3,
          }),
        ],
      },
    );
    openTab('jobs');
    expect(jobTitles()).toEqual(['job a', 'job b', 'job c']);
    expect(jobMetas(0)[0]).toBe('daily at 08:20');
    expect(jobMetas(0)[1]).toBe('no runs yet');
    expect(jobMetas(1)[0]).toContain('paused');
    // The failure line carries the outcome, the detail, how long ago, and the
    // streak the last run's own line cannot tell you.
    expect(jobMetas(2)[1]).toBe('failed — the /unload patch does not apply · 2h ago (failing ×3)');
  });

  it('marks Running only for the job whose turn is streaming in this window', () => {
    render(
      {},
      {
        jobs: [
          jobRow('a', { runningConversationId: 'conv-1' }),
          jobRow('b', { runningConversationId: 'conv-2' }),
        ],
        streamingIds: new Set(['conv-1']),
      },
    );
    openTab('jobs');
    const running = container.querySelector('.history-job-row .history-item-meta-running');
    expect(running?.textContent).toBe('◌ Running');
    // `b` has a persisted task_run marker for a chat this window is not
    // streaming: the marker alone cannot claim a live turn here.
    expect(jobMetas(1)[0]).toBe('daily at 08:20');
    expect(container.querySelectorAll('.history-item-meta-running')).toHaveLength(1);
  });

  it('asks the host to open a job when its row is clicked', () => {
    const onOpenJob = vi.fn();
    render({}, { jobs: [jobRow('a')], onOpenJob });
    openTab('jobs');
    click(container.querySelector<HTMLButtonElement>('#history-jobs-list .history-item')!);
    expect(onOpenJob).toHaveBeenCalledWith('a');
  });

  it('gives a job row no rename or delete menu', () => {
    render({}, { jobs: [jobRow('a')] });
    openTab('jobs');
    expect(container.querySelector('#history-jobs-list .history-item-kebab')).toBeNull();
  });

  it('does not disturb the frozen order of the Open rows', () => {
    render({}, { openItems: [tab('a', 5), tab('b', 4)], jobs: [jobRow('x')] });
    expect(openTitles()).toEqual(['chat a', 'chat b']);
    // The Jobs tab is read first because the Open rows and the job rows are in
    // different tabs now; the frozen order lives in the panel, not in the tab,
    // so switching tabs cannot be what re-sorts it.
    openTab('jobs');
    render({}, { openItems: [tab('b', 6), tab('a', 5)], jobs: [jobRow('x'), jobRow('y')] });
    expect(jobTitles()).toEqual(['job x', 'job y']);
    openTab('chats');
    expect(openTitles()).toEqual(['chat a', 'chat b']);
  });
});

describe('sessions panel — tabs', () => {
  const ARCHIVED = [
    { id: 'a1', title: 'old chat', createdAt: 1, updatedAt: 1 },
    { id: 'a2', title: 'older chat', createdAt: 1, updatedAt: 2 },
  ];

  it('names the three sections with their counts and opens on Chats', () => {
    render(
      {},
      {
        archived: ARCHIVED,
        jobs: [
          {
            id: 'j',
            name: 'watch',
            schedule: 'daily at 08:20',
            enabled: true,
            description: 'x',
            lastOutcomeLabel: 'ok',
            consecutiveFailures: 0,
            lastRun: null,
            runningConversationId: null,
          },
        ],
        jobsLoaded: true,
      },
    );
    expect(tabLabels()).toEqual(['Chats', 'Archived', 'Jobs']);
    expect(tabCounts()).toEqual(['Chats0', 'Archived4', 'Jobs1']);
    expect(tabButton('chats').querySelector('.history-tab-count')?.className).toContain(
      'history-tab-count--chats',
    );
    expect(tabButton('archived').querySelector('.history-tab-count')?.className).toContain(
      'history-tab-count--archived',
    );
    expect(tabButton('jobs').querySelector('.history-tab-count')?.className).not.toMatch(
      /--(chats|archived|failing)/u,
    );
    expect(tabButton('chats').getAttribute('aria-selected')).toBe('true');
    expect(tabButton('archived').getAttribute('aria-selected')).toBe('false');
    // One tabpanel, not three scroll boxes: the rows you are not looking at are
    // not in the DOM at all, which is also what keeps a 280-chat archive from
    // costing every open a layout.
    expect(container.querySelector('[role="tabpanel"]')?.id).toBe('history-tabpanel-chats');
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
  });

  it('shows the failing count in red on the Jobs badge, not the job count', () => {
    const failing = {
      id: 'j1',
      name: 'strata update',
      schedule: 'daily at 04:00',
      enabled: true,
      description: 'Job "strata update" [j1]',
      lastOutcomeLabel: 'failing ×2',
      consecutiveFailures: 2,
      lastRun: { at: 1, outcome: 'failed' as const, detail: 'the 3060 refused the load' },
      runningConversationId: null,
    };
    render(
      {},
      {
        jobs: [
          failing,
          {
            ...failing,
            id: 'j2',
            name: 'disk watch',
            lastOutcomeLabel: 'ok',
            consecutiveFailures: 0,
            lastRun: null,
          },
        ],
        jobsLoaded: true,
      },
    );
    const badge = container
      .querySelector('.history-tab-count')!
      .parentElement!.querySelector('.history-tab-count')!;
    expect(badge.textContent).toBe('0'); // the Chats tab: nothing open
    const jobsBadge = tabButton('jobs').querySelector('.history-tab-count')!;
    expect(jobsBadge.className).toContain('history-tab-count--failing');
    expect(jobsBadge.textContent).toBe('1');
    expect(tabButton('jobs').getAttribute('aria-controls')).toBe('history-tabpanel-jobs');
  });

  it('moves between tabs on the arrow keys and keeps one tab in the tab order', () => {
    render({}, { archived: ARCHIVED });
    expect(tabButton('chats').tabIndex).toBe(0);
    expect(tabButton('archived').tabIndex).toBe(-1);
    act(() => {
      tabButton('chats').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(tabButton('archived').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[role="tabpanel"]')?.id).toBe('history-tabpanel-archived');
    // Roving tabindex only works if focus follows it, or the next Tab lands back
    // on the search box instead of on the tab that is now selected.
    expect(document.activeElement).toBe(tabButton('archived'));
    act(() => {
      tabButton('archived').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
    });
    expect(tabButton('chats').getAttribute('aria-selected')).toBe('true');
    act(() => {
      tabButton('chats').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
    });
    expect(tabButton('chats').getAttribute('aria-selected')).toBe('true');
  });

  it('returns to the Chats tab with an empty search box when the panel reopens', () => {
    render({}, { archived: ARCHIVED });
    openTab('jobs');
    setValue('anything');
    expect(container.querySelector<HTMLInputElement>('#history-search')!.value).toBe('anything');
    act(() => {
      root.render(
        React.createElement(HistoryList, {
          items: ITEMS,
          archived: ARCHIVED,
          expanded: false,
          onDismiss: vi.fn(),
          onRestore: vi.fn(),
          onDelete: vi.fn(),
          onRename: vi.fn(),
        }),
      );
    });
    act(() => {
      root.render(
        React.createElement(HistoryList, {
          items: ITEMS,
          archived: ARCHIVED,
          expanded: true,
          onDismiss: vi.fn(),
          onRestore: vi.fn(),
          onDelete: vi.fn(),
          onRename: vi.fn(),
        }),
      );
    });
    expect(tabButton('chats').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('#history-search')!.value).toBe('');
  });
});

describe('sessions panel — search', () => {
  it('filters the current tab as you type, case-insensitively', () => {
    renderClosed();
    setValue('MAN');
    expect(container.querySelectorAll('#history-list .history-item')).toHaveLength(1);
    expect(container.querySelector('#history-list .history-item-title')?.textContent).toBe(
      'hello man',
    );
    setValue('');
    expect(container.querySelectorAll('#history-list .history-item')).toHaveLength(ITEMS.length);
  });

  it('says nothing matches rather than that the tab is empty', () => {
    renderClosed();
    setValue('zzz');
    expect(container.querySelector('#history-no-match')?.textContent).toBe(
      'Nothing matches "zzz".',
    );
    expect(container.querySelector('#history-empty')).toBeNull();
    setValue('second');
    expect(container.querySelector('#history-no-match')).toBeNull();
    expect(container.querySelectorAll('#history-list .history-item')).toHaveLength(1);
  });

  it('keeps an unsearched empty panel on its own empty text', () => {
    render({}, { items: [], openItems: [], archived: [] });
    expect(container.querySelector('#history-empty')?.textContent).toBe('No open chats.');
    setValue('zzz');
    expect(container.querySelector('#history-empty')?.textContent).toBe('No open chats.');
  });

  it('filters jobs on their name and their last outcome, not on the clock', () => {
    const job = {
      id: 'j1',
      name: 'Maya engine update',
      schedule: 'daily at 08:20',
      enabled: true,
      description: 'Job "Maya engine update" [j1]',
      lastOutcomeLabel: 'failing ×3',
      consecutiveFailures: 3,
      lastRun: {
        at: Date.now() - 2 * 3_600_000,
        outcome: 'failed' as const,
        detail: 'the /unload patch does not apply',
      },
      runningConversationId: null,
    };
    render(
      {},
      {
        jobs: [
          job,
          {
            ...job,
            id: 'j2',
            name: 'disk watch',
            lastOutcomeLabel: 'ok',
            consecutiveFailures: 0,
            lastRun: { at: 1, outcome: 'ok' as const, detail: '312 GB free' },
          },
        ],
        jobsLoaded: true,
      },
    );
    openTab('jobs');
    setValue('unload patch');
    expect(jobTitlesInJobsTab()).toEqual(['Maya engine update']);
    setValue('disk');
    expect(jobTitlesInJobsTab()).toEqual(['disk watch']);
    setValue('2h ago');
    expect(container.querySelector('#history-no-match')?.textContent).toBe(
      'Nothing matches "2h ago".',
    );
  });

  function jobTitlesInJobsTab(): string[] {
    return Array.from(container.querySelectorAll('#history-jobs-list .history-item-title')).map(
      (el) => el.textContent ?? '',
    );
  }
});

describe('sessions panel — quiet rows', () => {
  // The real rule text, from the file that owns it: what a hover-only control
  // means is a CSS fact, and testing it against the CSS that ships is the only
  // way it cannot drift from the component.
  const rowsCss = readFileSync('webview-ui/styles/history-rows.css', 'utf8');
  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = rowsCss;
    document.head.appendChild(style);
  });
  afterEach(() => style.remove());

  it('keeps the kebab visible and clickable without requiring hover', () => {
    renderClosed();
    const row = container.querySelectorAll('.history-item-row')[0]!;
    const kebab = row.querySelector('.history-item-kebab') as HTMLElement;
    // Quiet actions remain discoverable on touch and clickable immediately.
    expect(kebabs()).toHaveLength(2);
    expect(getComputedStyle(kebab).opacity).toBe('0.6');
    expect(getComputedStyle(kebab).pointerEvents).not.toBe('none');
    expect(kebab.tabIndex).toBe(0);
    // The two paths that make it visible are `:hover` and `:focus-within`, and
    // jsdom evaluates neither (it has no hover state and does not match
    // `:focus-within` in computed style), so they are checked as the rule text
    // that ships — and both are exercised in a real browser against the built
    // bundle before this change is called done.
    expect(/\.history-item-row:hover \.history-item-kebab/.test(rowsCss)).toBe(true);
    expect(/\.history-item-row:focus-within \.history-item-kebab/.test(rowsCss)).toBe(true);
    // What jsdom can prove: the third path, a row whose own menu is open, is a
    // class, and it does make the control visible and interactive.
    click(kebab);
    expect(getComputedStyle(kebab).opacity).toBe('1');
    expect(getComputedStyle(kebab).pointerEvents).toBe('auto');
  });

  it('keeps the kebab up while its own menu is open', () => {
    renderClosed();
    const row = container.querySelectorAll('.history-item-row')[0]!;
    const kebab = row.querySelector('.history-item-kebab') as HTMLElement;
    click(kebab);
    expect(row.className).toContain('history-item-row-active');
    expect(getComputedStyle(kebab).visibility).toBe('visible');
  });

  it('gives a failing job a filled dot and an error-styled row', () => {
    const failed = {
      id: 'j1',
      name: 'Maya engine update',
      schedule: 'daily at 08:20',
      enabled: true,
      description: 'Job "Maya engine update" [j1]',
      lastOutcomeLabel: 'failing ×2',
      consecutiveFailures: 2,
      lastRun: { at: 1, outcome: 'failed' as const, detail: 'the load failed' },
      runningConversationId: null,
    };
    render(
      {},
      {
        jobs: [
          {
            ...failed,
            id: 'j0',
            lastOutcomeLabel: 'no runs yet',
            consecutiveFailures: 0,
            lastRun: null,
          },
          failed,
        ],
        jobsLoaded: true,
      },
    );
    openTab('jobs');
    const rows = container.querySelectorAll('#history-jobs-list .history-item-row');
    // A job that has never run gets the hollow dot; the one that failed its last
    // run gets the filled one and the error colour on its outcome line.
    expect(rows[0]!.className).toContain('history-job-status-none');
    expect(rows[0]!.querySelector('.history-row-dot--none')).not.toBeNull();
    expect(rows[1]!.className).toContain('history-job-status-failing');
    expect(rows[1]!.querySelector('.history-row-dot--failing')).not.toBeNull();
    // The error colour itself is a `var()` the theme supplies, which jsdom does
    // not resolve; the class that carries it is what is checked here, and the
    // rendered colour is checked against the real bundle in the browser probe.
  });
});

describe('sessions panel — who started the chat', () => {
  it("badges an agent chat by name and a person's chat as You", () => {
    renderClosed(
      {},
      {
        items: [
          {
            id: 'new',
            title: 'Split SdServerBackend.ts',
            createdAt: 1,
            updatedAt: 9,
            origin_agent: 'claude',
            title_source: 'prompt' as const,
          },
          {
            id: 'old',
            title: 'Claude: Claude here, with an owner-approved UI task',
            createdAt: 1,
            updatedAt: 8,
            title_source: 'prompt' as const,
          },
          { id: 'typed', title: 'Rename the config folder', createdAt: 1, updatedAt: 7 },
        ],
      },
    );
    const badges = Array.from(container.querySelectorAll('#history-list .history-row-badge')).map(
      (el) => `${el.textContent}/${el.className}`,
    );
    expect(badges[0]).toBe(
      'Claude/history-row-badge history-row-badge-agent history-row-badge-claude',
    );
    expect(badges[1]).toBe(
      'Claude/history-row-badge history-row-badge-agent history-row-badge-claude',
    );
    expect(badges[2]).toBe('You/history-row-badge');
    // The old prefix is gone from the title, and the stored title is untouched:
    // the row shows the name without it, not a rewritten file.
    const titles = Array.from(container.querySelectorAll('#history-list .history-item-title')).map(
      (el) => el.textContent ?? '',
    );
    expect(titles).toEqual([
      'Split SdServerBackend.ts',
      'Claude here, with an owner-approved UI task',
      'Rename the config folder',
    ]);
  });

  it('leaves a name a person typed wearing its prefix', () => {
    renderClosed(
      {},
      {
        items: [
          {
            id: 'renamed',
            title: 'Claude: what about the flaky test',
            createdAt: 1,
            updatedAt: 9,
            title_source: 'user' as const,
          },
        ],
      },
    );
    expect(container.querySelector('#history-list .history-item-title')?.textContent).toBe(
      'Claude: what about the flaky test',
    );
    expect(container.querySelector('.history-row-badge')?.textContent).toBe('You');
  });

  it('badges a chat bound to a phone conversation with the channel', () => {
    renderClosed(
      {},
      {
        items: [
          {
            id: 'phone',
            title: 'Maya engine status',
            createdAt: 1,
            updatedAt: 9,
            origin_channel: 'telegram' as const,
          },
          { id: 'here', title: 'Rename the config folder', createdAt: 1, updatedAt: 7 },
        ],
      },
    );
    const badges = Array.from(container.querySelectorAll('#history-list .history-row-badge'));
    expect(badges.map((el) => el.textContent)).toEqual(['Telegram', 'You']);
    expect(badges[0]!.className).toBe(
      'history-row-badge history-row-badge-agent history-row-badge-telegram',
    );
    // The tooltip is what keeps the badge honest: a chat a person picked with
    // /chat is bound too, so the row says what is bound, not how it began.
    expect(badges[0]!.getAttribute('title')).toBe('Bound to a Telegram chat');
  });
});

describe('sessions panel — the size the host stored', () => {
  /** One `sessionSync`, exactly as a reload or a second window would deliver it. */
  const syncWithSize = (size: { width: number; height: number }): void => {
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'sessionSync', historyPanelSize: size } }),
      );
    });
  };

  it('applies the size the host sent, so a reload or another window opens the panel as it was last sized', () => {
    render();
    syncWithSize({ width: 340, height: 520 });
    const panel = container.querySelector<HTMLElement>('#history-panel')!;
    expect(panel.style.width).toBe('340px');
    expect(panel.style.height).toBe('520px');
  });

  it('takes the size from no other message', () => {
    render();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'models', historyPanelSize: { width: 340, height: 520 } },
        }),
      );
    });
    // The panel has a size as soon as it is open — the default is today's width,
    // not "no inline style" — so what this test pins is that a size carried by
    // the wrong message is ignored: the panel keeps its default instead of the
    // 340 px somebody tried to hand it on a `models` message.
    expect(container.querySelector<HTMLElement>('#history-panel')!.style.width).toBe(
      `${DEFAULT_PANEL_WIDTH}px`,
    );
  });

  it('stops taking one as soon as this window has chosen its own, so a sync cannot move the panel under the pointer', () => {
    render();
    syncWithSize({ width: 340, height: 520 });
    // A key press on the grip is this window choosing its own size.
    act(() => {
      container
        .querySelector<HTMLElement>('.history-resize-grip')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    syncWithSize({ width: 300, height: 400 });
    expect(container.querySelector<HTMLElement>('#history-panel')!.style.width).toBe('330px');
  });
});

describe('sessions panel — the age line keeps itself current', () => {
  it('runs its one-minute tick only while the panel is open', () => {
    // The tick is the only timer the panel owns, and a panel that is closed has
    // nothing to age: closing it has to take the timer with it, or every open
    // flyout in the sidebar would keep redrawing on a clock nobody is reading.
    vi.useFakeTimers();
    try {
      const baseline = vi.getTimerCount();
      render();
      expect(vi.getTimerCount()).toBe(baseline + 1);
      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(vi.getTimerCount()).toBe(baseline + 1);
      render({}, { expanded: false });
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The outcome line of a job row — the one that carries "… · 2h ago". */
  const jobAgeLine = (): string => {
    const row = container.querySelector('#history-jobs-list .history-item-row');
    if (!row) return '';
    return (
      Array.from(row.querySelectorAll('.history-item-meta')).map((el) => el.textContent ?? '')[1] ??
      ''
    );
  };

  it('draws the age against the clock as it is now when the panel reopens', () => {
    // The reopen is the case that mattered. A panel closed for ten hours kept
    // showing the age from the last tick before it closed, and only the first
    // minute tick after reopening moved it: a run stopped yesterday read
    // "23h ago" the moment you opened the panel again, and stayed there for a
    // minute. The reset belongs in the effect that owns the timer, so it runs
    // on every open and goes away with the close.
    vi.useFakeTimers();
    try {
      const job = {
        id: 'j1',
        name: 'Maya engine update',
        schedule: 'daily at 08:20',
        enabled: true,
        description: 'Job "Maya engine update" [j1]',
        lastOutcomeLabel: 'ok',
        consecutiveFailures: 0,
        lastRun: {
          at: Date.now() - 10 * 60_000,
          outcome: 'ok' as const,
          detail: 'nothing changed',
        },
        runningConversationId: null,
      };
      render({}, { jobs: [job], jobsLoaded: true });
      openTab('jobs');
      expect(jobAgeLine()).toContain('10m ago');
      // A tick moves the age, exactly as it always did.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(jobAgeLine()).toContain('11m ago');
      // Close, ten hours pass with the panel shut and no timer running, reopen.
      render({}, { expanded: false, jobs: [job], jobsLoaded: true });
      act(() => {
        vi.advanceTimersByTime(10 * 3_600_000);
      });
      render({}, { expanded: true, jobs: [job], jobsLoaded: true });
      openTab('jobs');
      // Eleven minutes after the run would still be the honest answer only if
      // the clock had been frozen; it is 10h11m after, and no tick has run
      // since the reopen, so this line can only be right if the open reset it.
      expect(jobAgeLine()).toContain('10h ago');
    } finally {
      vi.useRealTimers();
    }
  });
});
