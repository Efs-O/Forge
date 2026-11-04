// @vitest-environment jsdom
/**
 * The sessions panel's search box against its host: what gets asked, which
 * answer is still current, and what the panel says between the two.
 *
 * The filter itself is asserted in `test/unit/HistoryPanelFilter.test.ts`; what
 * only a render can show is the loading and partial states, and the three ways
 * an answer can arrive too late to be applied — a newer query, another tab, and
 * a panel that has closed or been replaced. `panelId` is what App hands down
 * for the open panel, so these renders pass it the way the real panel gets it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SEARCH_DEBOUNCE_MS } from '../../src/sidebar/sessionSearchMessages';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: unknown[] = [];
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: (msg: unknown) => posted.push(msg) });

const { HistoryList } = await import('../../webview-ui/src/components/HistoryList');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;

/** Closed chats: the Archived tab draws these, and neither title says `wobble`. */
const CLOSED = [
  { id: 'a', title: 'hello man', createdAt: 1, updatedAt: 3, messageCount: 10 },
  { id: 'b', title: 'second chat', createdAt: 1, updatedAt: 2, messageCount: 7 },
];
const OPEN = [
  { id: 'open-1', title: 'first open chat', createdAt: 1, updatedAt: 5 },
  { id: 'open-2', title: 'second open chat', createdAt: 1, updatedAt: 4 },
];

beforeEach(() => {
  posted.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(over: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      React.createElement(HistoryList, {
        items: CLOSED,
        openItems: OPEN,
        expanded: true,
        panelId: 1,
        onDismiss: vi.fn(),
        onRestore: vi.fn(),
        onDelete: vi.fn(),
        onRename: vi.fn(),
        ...over,
      }),
    );
  });
}

const click = (el: HTMLElement): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const openTab = (id: 'chats' | 'archived' | 'jobs'): void =>
  click(container.querySelector<HTMLButtonElement>(`#history-tab-${id}`)!);

/** Typing, then the debounce. `advanceMs` lets a test stop short of it. */
function type(value: string, advanceMs = SESSION_SEARCH_DEBOUNCE_MS): void {
  const box = container.querySelector<HTMLInputElement>('#history-search')!;
  const setter = Object.getOwnPropertyDescriptor!(window.HTMLInputElement.prototype, 'value').set!;
  act(() => {
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(advanceMs);
  });
}

const requests = (): Extract<{ type: 'sessionSearchQuery' }, unknown>[] =>
  posted.filter(
    (msg): msg is { type: 'sessionSearchQuery'; panelId: number; requestId: number; tab: string; query: string } =>
      (msg as { type?: string }).type === 'sessionSearchQuery' &&
      (msg as { query?: string }).query !== '',
  );

/** The host answering this panel. Every field is spelled out so a test can vary one. */
function answer(over: Partial<
  Extract<HostToWebview, { type: 'sessionSearchResult' }>
> = {}): void {
  const message: HostToWebview = {
    type: 'sessionSearchResult',
    panelId: 1,
    requestId: 1,
    tab: 'archived',
    query: 'wobble',
    ids: [],
    complete: true,
    ...over,
  };
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

const closedTitles = (): string[] =>
  Array.from(container.querySelectorAll('#history-list .history-item-title')).map(
    (el) => el.textContent ?? '',
  );
const openTitles = (): string[] =>
  Array.from(container.querySelectorAll('#history-open-list .history-item-title')).map(
    (el) => el.textContent ?? '',
  );

describe('the search box asking the host', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('asks once per stopped typing, naming the panel, the query and the tab', () => {
    render();
    type('wobble');
    expect(requests()).toEqual([
      { type: 'sessionSearchQuery', panelId: 1, requestId: 1, tab: 'chats', query: 'wobble' },
    ]);
  });

  it('does not ask for every keystroke: a burst inside the debounce is one request', () => {
    render();
    type('w', 100);
    type('wo', 100);
    type('wob', 100);
    expect(requests()).toHaveLength(0);
    type('wobble');
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.query).toBe('wobble');
    // One id, because only one request was ever sent: the discarded partial
    // keystrokes never reached the host, so they never consumed a generation.
    expect(requests()[0]?.requestId).toBe(1);
  });

  it('does not ask for an empty box, a Jobs tab, or a panel that is not open', () => {
    render();
    type('');
    expect(requests()).toHaveLength(0);

    openTab('jobs');
    type('wobble');
    expect(requests()).toHaveLength(0);

    render({ panelId: 0 });
    type('wobble');
    expect(requests()).toHaveLength(0);
  });

  it('asks again when you switch tabs, because the two tabs search different chats', () => {
    render();
    type('wobble');
    openTab('archived');
    type('wobble');
    expect(requests().map((request) => request.tab)).toEqual(['chats', 'archived']);
    expect(requests().map((request) => request.requestId)).toEqual([1, 2]);
  });

  it.each(['clear', 'jobs'] as const)('cancels the host scan on %s', (action) => {
    render();
    type('wobble');
    if (action === 'clear') type('');
    else openTab('jobs');
    expect(posted.at(-1)).toEqual({
      type: 'sessionSearchQuery', panelId: 1, requestId: 1, tab: 'chats', query: '',
    });
    expect(requests()).toHaveLength(1);
  });

  it('gives each new query its own id, so an answer to the old text can be recognised as stale', () => {
    render();
    type('wobble');
    type('wobbl');
    expect(requests().map((request) => request.requestId)).toEqual([1, 2]);
    expect(requests().map((request) => request.query)).toEqual(['wobble', 'wobbl']);
  });
});

describe('applying what the host found', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('draws a row the host matched by its saved text, though its title says nothing of it', () => {
    render();
    openTab('archived');
    type('wobble');
    answer({ tab: 'archived', query: 'wobble', ids: ['b'] });
    expect(closedTitles()).toEqual(['second chat']);
  });

  it('keeps the title and badge matching it had before, while the host is still reading', () => {
    render();
    openTab('archived');
    type('second');
    // `second chat` answers to its own title, so it must appear before the host
    // has said anything at all: the content search adds rows, it never replaces
    // the filter that was already there.
    expect(closedTitles()).toEqual(['second chat']);
    answer({ tab: 'archived', query: 'second', ids: ['a'] });
    expect(closedTitles()).toEqual(['second chat', 'hello man']);
  });

  it('says it is searching rather than that nothing matches, until the walk completes', () => {
    render();
    openTab('archived');
    type('wobble');
    expect(container.querySelector('#history-search-pending')?.textContent).toBe(
      'Searching saved chats…',
    );
    expect(container.querySelector('#history-no-match')).toBeNull();
    answer({ tab: 'archived', query: 'wobble', ids: [], complete: true });
    expect(container.querySelector('#history-search-pending')).toBeNull();
    expect(container.querySelector('#history-no-match')?.textContent).toBe(
      'Nothing matches "wobble".',
    );
  });

  it('says so when the rows it drew came from a walk that is still going', () => {
    render();
    openTab('archived');
    type('wobble');
    answer({ tab: 'archived', query: 'wobble', ids: ['b'], complete: false });
    expect(closedTitles()).toEqual(['second chat']);
    expect(container.querySelector('#history-search-partial')?.textContent).toBe(
      'Still searching saved chats…',
    );
    answer({ tab: 'archived', query: 'wobble', ids: ['a', 'b'], complete: true });
    expect(closedTitles()).toEqual(['hello man', 'second chat']);
    expect(container.querySelector('#history-search-partial')).toBeNull();
  });

  it('admits the chats it could not read, beside a no-match as well as beside rows', () => {
    render();
    openTab('archived');
    type('wobble');
    answer({ tab: 'archived', query: 'wobble', ids: [], complete: true, unreadable: 2 });
    expect(container.querySelector('#history-no-match')).not.toBeNull();
    expect(container.querySelector('#history-search-unreadable')?.textContent).toBe(
      'Search could not read 2 saved chats.',
    );
    answer({ tab: 'archived', query: 'wobble', ids: ['b'], complete: true, unreadable: 1 });
    expect(container.querySelector('#history-search-unreadable')?.textContent).toBe(
      'Search could not read 1 saved chat.',
    );
  });

  it('clears what the host found as soon as the box changes, so a match is never left on screen for text that is not typed', () => {
    render();
    openTab('archived');
    type('wobble');
    answer({ tab: 'archived', query: 'wobble', ids: ['b'] });
    expect(closedTitles()).toEqual(['second chat']);
    // A different query, answered by titles alone: `b` came back from the host
    // for `wobble`, and carrying it over would put a row on screen that nobody
    // asked for.
    type('hello');
    expect(closedTitles()).toEqual(['hello man']);
  });

  it('renders highlighted literal previews safely and orders results by relevance', () => {
    render();
    openTab('archived');
    type('wobble');
    answer({
      ids: ['a', 'b'],
      hits: [
        { id: 'a', score: 1, snippet: 'a wobble' },
        { id: 'b', score: 10, snippet: '<img src=x onerror=alert(1)> Wobble fixed' },
      ],
    });
    expect(closedTitles()).toEqual(['second chat', 'hello man']);
    const preview = container.querySelector('.history-search-preview')!;
    expect(preview.textContent).toBe('<img src=x onerror=alert(1)> Wobble fixed');
    expect(preview.querySelector('mark')?.textContent).toBe('Wobble');
    expect(preview.querySelector('img')).toBeNull();
    type('second');
    expect(container.querySelector('.history-search-preview')).toBeNull();
    expect(container.querySelector('.history-item-title mark')?.textContent).toBe('second');
  });

  it('keeps metadata matches hidden until exclusions are checked in the transcript', () => {
    render();
    openTab('archived');
    type('second -ollama');
    expect(closedTitles()).toEqual([]);
    expect(container.querySelector('#history-search-pending')).not.toBeNull();
    answer({ query: 'second -ollama', ids: [] });
    expect(closedTitles()).toEqual([]);
    answer({ query: 'second -ollama', ids: ['b'], hits: [{ id: 'b', score: 10 }] });
    expect(closedTitles()).toEqual(['second chat']);
  });
});

describe('an answer that arrived too late', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('ignores a reply to the text that is no longer in the box', () => {
    render();
    openTab('archived');
    type('wobble');
    type('wobbl');
    // The first query's answer, arriving after the box has changed: it names
    // `wobble`, which is no longer what was typed, and its id is the older one.
    answer({ tab: 'archived', query: 'wobble', requestId: 1, ids: ['b'] });
    // Nothing to draw, and the panel says it is still searching rather than
    // that nothing matches: the answer for the current text has not landed.
    expect(closedTitles()).toEqual([]);
    expect(container.querySelector('#history-search-pending')).not.toBeNull();
    answer({ tab: 'archived', query: 'wobbl', requestId: 2, ids: ['b'] });
    expect(closedTitles()).toEqual(['second chat']);
  });

  it('ignores a reply addressed to the other tab', () => {
    render();
    type('wobble');
    openTab('archived');
    type('wobble');
    // The Chats request's answer, landing after the tab changed. It is a real
    // answer to a real request; this panel is just no longer showing that tab,
    // so applying it would filter the wrong list with the wrong set.
    answer({ tab: 'chats', query: 'wobble', requestId: 1, ids: ['b'] });
    expect(closedTitles()).toEqual([]);
    answer({ tab: 'archived', query: 'wobble', requestId: 2, ids: ['b'] });
    expect(closedTitles()).toEqual(['second chat']);
  });

  it('ignores a reply for a panel this window no longer has open', () => {
    render();
    openTab('archived');
    type('wobble');
    answer({ tab: 'archived', query: 'wobble', panelId: 2, ids: ['b'] });
    expect(closedTitles()).toEqual([]);
    answer({ tab: 'archived', query: 'wobble', panelId: 1, ids: ['b'] });
    expect(closedTitles()).toEqual(['second chat']);
  });

  it('stops asking, and stops accepting, the moment the panel closes', () => {
    render();
    openTab('archived');
    type('wobble');
    expect(requests()).toHaveLength(1);
    render({ expanded: false, onDismiss: vi.fn() });
    render({ expanded: true });
    // Reopening starts at the Chats tab with an empty box, so nothing has been
    // asked yet — and an answer to the closed panel's query cannot reach the new
    // one, whose generation has changed under it.
    expect(requests()).toHaveLength(1);
    answer({ tab: 'archived', query: 'wobble', ids: ['b'] });
    expect(closedTitles()).toEqual([]);
    expect(openTitles()).toEqual(['first open chat', 'second open chat']);
  });
});

describe('a panel with no host to ask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('still filters by title and says nothing matches, without pretending a search ran', () => {
    render({ panelId: 0 });
    openTab('archived');
    type('zzz');
    expect(container.querySelector('#history-no-match')?.textContent).toBe(
      'Nothing matches "zzz".',
    );
    expect(container.querySelector('#history-search-pending')).toBeNull();
    expect(requests()).toHaveLength(0);
  });
});
