// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SEARCH_DEBOUNCE_MS } from '../../src/sidebar/sessionSearchMessages';
import type { HostToWebview, JobPanelMeta } from '../../src/sidebar/messageBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: unknown[] = [];
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({
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

/** The panel opens on the Chats tab, so a test that reads the Jobs list has to
 *  ask for the tab that owns it: only the selected tab's rows are in the DOM. */
function openJobsTab(): void {
  click(panel().querySelector<HTMLButtonElement>('#history-tab-jobs')!);
}

/** Closed chats live under Archived; Chats holds only the open tabs. */
function openArchivedTab(): void {
  click(panel().querySelector<HTMLButtonElement>('#history-tab-archived')!);
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
  it('lists only open sessions under Chats and switches from the panel', () => {
    openPanel();
    const rows = panel().querySelectorAll<HTMLButtonElement>('#history-open-list .history-item');
    expect(rows.length).toBe(2);
    expect(panel().querySelector('#history-list')).toBeNull();
    click(rows[1]!);
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
    openArchivedTab();
    const restore = panel().querySelector<HTMLButtonElement>('#history-list .history-item');
    if (!restore) throw new Error('closed row not rendered');
    click(restore);

    expect(posted).toContainEqual({ type: 'restoreConversation', id: 'old-1' });
    expect(panel().hidden).toBe(true);
  });

  it('returns focus to the toggle, so keyboard users do not land on <body>', () => {
    openPanel();
    openArchivedTab();
    const restore = panel().querySelector<HTMLButtonElement>('#history-list .history-item');
    if (!restore) throw new Error('closed row not rendered');
    click(restore);

    expect(document.activeElement).toBe(toggle());
  });

  it('leaves the panel open when a row is only renamed', () => {
    // Management, not navigation: walking down the list must survive it.
    openPanel();
    openArchivedTab();
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

describe('sessions panel — jobs section', () => {
  const jobMeta = (
    id: string,
    name: string,
    over: Partial<JobPanelMeta> = {},
  ): JobPanelMeta => ({
    id,
    name,
    schedule: 'daily at 08:20',
    enabled: true,
    description: `Job "${name}" [${id}]`,
    lastOutcomeLabel: 'no runs yet',
    lastRun: null,
    runningConversationId: null,
    ...over,
  });

  /** The host answering the panel this window has open. */
  function sendJobs(panelId: number, jobs: JobPanelMeta[]): void {
    act(() => {
      hostMessage({ type: 'jobsSnapshot', panelId, jobs });
    });
  }

  /** A window with nothing in its history, so only the Jobs section can fill it. */
  function emptySync(): void {
    act(() => {
      hostMessage({
        type: 'sessionSync',
        activeId: '',
        tabs: [],
        history: [],
        messagesById: {},
      });
    });
  }

  it('asks the host for the store when the panel opens and releases it when it closes', () => {
    openPanel();
    expect(posted).toContainEqual({ type: 'jobsPanelOpened', panelId: 1 });
    click(toggle());
    expect(posted).toContainEqual({ type: 'jobsPanelClosed', panelId: 1 });
  });

  it('gives the search box the same panel generation it gives the Jobs section', () => {
    // One number for both, because both are answers to this open panel: two
    // counters would let the search and the store push disagree about which
    // panel is open, and a reply could then be applied to the wrong one.
    vi.useFakeTimers();
    try {
      openPanel();
      const box = panel().querySelector<HTMLInputElement>('#history-search')!;
      const setter = Object.getOwnPropertyDescriptor!(
        window.HTMLInputElement.prototype,
        'value',
      ).set!;
      act(() => {
        setter.call(box, 'wobble');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => {
        vi.advanceTimersByTime(SESSION_SEARCH_DEBOUNCE_MS);
      });
      expect(posted).toContainEqual({
        type: 'sessionSearchQuery',
        panelId: 1,
        requestId: 1,
        tab: 'chats',
        query: 'wobble',
      });
      click(toggle());
      expect(posted).toContainEqual({ type: 'jobsPanelClosed', panelId: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the jobs the host sends, in the order the store gave them', () => {
    openPanel();
    sendJobs(1, [
      jobMeta('maya', 'Maya engine update'),
      jobMeta('strata', 'Strata update', { enabled: false }),
    ]);
    openJobsTab();
    const rows = panel().querySelectorAll<HTMLButtonElement>('#history-jobs-list .history-item');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('Maya engine update');
    expect(rows[1]?.textContent).toContain('paused');
  });

  it('ignores a snapshot for a panel that is not the one open', () => {
    openPanel();
    openJobsTab();
    click(toggle());
    openPanel(); // generation 2, and the Chats tab: a reopen always starts there
    openJobsTab();
    sendJobs(1, [jobMeta('stale', 'Stale job')]);
    expect(panel().querySelector('#history-jobs-list')).toBeNull();
    expect(panel().querySelector('#history-jobs-empty')?.textContent).toBe('Loading jobs…');
    sendJobs(2, [jobMeta('fresh', 'Fresh job')]);
    expect(panel().querySelector('#history-jobs-list .history-item')?.textContent).toContain(
      'Fresh job',
    );
  });

  it('dismisses only after the host confirms the job opened', () => {
    openPanel();
    sendJobs(1, [jobMeta('maya', 'Maya engine update')]);
    openJobsTab();
    const row = panel().querySelector<HTMLButtonElement>('#history-jobs-list .history-item');
    if (!row) throw new Error('job row not rendered');
    click(row);
    expect(posted).toContainEqual({ type: 'openJob', panelId: 1, id: 'maya' });
    // Still open: nothing has yet said the chat actually opened, and a job that
    // was deleted or a discuss that was refused must leave the panel visible.
    expect(panel().hidden).toBe(false);
    act(() => {
      hostMessage({ type: 'jobOpened', panelId: 1, id: 'maya' });
    });
    expect(panel().hidden).toBe(true);
  });

  it('stays open when the acknowledgement belongs to another generation', () => {
    openPanel();
    sendJobs(1, [jobMeta('maya', 'Maya engine update')]);
    openJobsTab();
    click(panel().querySelector<HTMLButtonElement>('#history-jobs-list .history-item')!);
    act(() => {
      hostMessage({ type: 'jobOpened', panelId: 2, id: 'maya' });
    });
    expect(panel().hidden).toBe(false);
  });

  it('opens with no conversations at all, because jobs are a reason to open it', () => {
    emptySync();
    click(toggle());
    expect(panel().hidden).toBe(false);
    sendJobs(1, [jobMeta('maya', 'Maya engine update')]);
    expect(panel().hidden).toBe(false);
    openJobsTab();
    expect(panel().querySelector('#history-jobs-list .history-item')).not.toBeNull();
  });

  it('still collapses an empty window once the host says there are no jobs either', () => {
    emptySync();
    click(toggle());
    expect(panel().hidden).toBe(false);
    sendJobs(1, []);
    expect(panel().hidden).toBe(true);
  });
});
