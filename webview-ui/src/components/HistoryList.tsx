import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import type {
  JobPanelMeta,
  SessionHistoryMeta,
  SessionTabMeta,
} from '../../../src/sidebar/messageBridge';
import { orderOpenItems } from '../openItemOrder';
import { useResizablePanel } from '../useResizablePanel';
import { failingJobCount } from '../historyFilter';
import { useSessionContentSearch } from '../sessionContentSearch';
import { SESSION_SEARCH_QUERY_MAX_CHARS } from '../../../src/sidebar/sessionSearchMessages';
import { HistoryTabContent, type PanelTab } from './HistoryTabContent';

// The row-age wording is owned by the row that shows it; this re-export keeps
// `TranscriptPanes`'s resumed marker reading the same single source it always did.
export { relativeTime } from './HistoryChatRow';

interface Props {
  items: SessionHistoryMeta[];
  archived?: SessionHistoryMeta[];
  openItems?: SessionTabMeta[];
  activeId?: string;
  streamingIds?: ReadonlySet<string>;
  queuedIds?: ReadonlySet<string>;
  waitingIds?: ReadonlySet<string>;
  expanded: boolean;
  /** Escape or a click outside the panel. */
  onDismiss: () => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onResetApprovals: (id: string) => void;
  onClose?: (id: string) => void;
  onSwitchOpen?: (id: string) => void;
  onSetKeepOpen?: (id: string, keepOpen: boolean) => void;
  /** The job store, as the host read it for this panel's generation. */
  jobs?: JobPanelMeta[];
  /** False until the host has answered the panel that is open. */
  jobsLoaded?: boolean;
  /**
   * The panel generation App is holding for this open panel; 0 means the panel
   * is closed, so the search box asks the host for nothing. It is App's, not
   * the panel's, because the same number already scopes the Jobs pushes and a
   * second counter here could disagree with the one the host is answering.
   */
  panelId?: number;
  /** A job row was clicked. App sends the navigation; the host's `jobOpened` is what dismisses the panel. */
  onOpenJob?: (id: string) => void;
}

const TABS = [
  { id: 'chats', label: 'Chats' },
  { id: 'archived', label: 'Archived' },
  { id: 'jobs', label: 'Jobs' },
] as const;

/** What each tab is searching, so the placeholder answers the question being asked. */
const SEARCH_PLACEHOLDER: Record<PanelTab, string> = {
  chats: 'Search chats',
  archived: 'Search archived chats',
  jobs: 'Search jobs',
};

/**
 * The sessions panel's shell: search box, tab strip, one scroll container, the
 * resize grip, and the dismissal contract an overlay floating over the
 * transcript needs. What each tab shows is `HistoryTabContent`'s.
 */
export function HistoryList({
  items,
  archived = [],
  expanded,
  onDismiss,
  onRestore,
  onDelete,
  onRename,
  onResetApprovals,
  openItems = [],
  activeId = '',
  streamingIds = new Set<string>(),
  queuedIds = new Set<string>(),
  waitingIds = new Set<string>(),
  onClose = () => undefined,
  onSwitchOpen,
  onSetKeepOpen = () => undefined,
  jobs = [],
  jobsLoaded = true,
  panelId = 0,
  onOpenJob = () => undefined,
}: Props): ReactElement {
  const [tab, setTab] = useState<PanelTab>('chats');
  const [query, setQuery] = useState('');
  // The saved chats the host has read so far for the text in the box. Titles
  // and badges are matched in `historyFilter.ts`; only the host can say which
  // transcripts contain a phrase, so this is the half that comes back from it.
  const contentSearch = useSessionContentSearch({ panelId, tab, query });
  // Relative last-run labels age by the minute without another store read. The
  // tick runs only while the panel is open — a hidden panel has nothing to age,
  // and the interval goes with the close. It also resets the clock on open: a
  // panel reopened hours later has to draw the age against the time it is now,
  // not against the last tick before it closed, which is what a row showed until
  // the first minute tick after reopening — a run stopped yesterday reading
  // "23h ago" the moment you opened the panel again.
  const [nowTick, setNowTick] = useState(() => new Date());
  useEffect(() => {
    if (!expanded) return;
    setNowTick(new Date());
    const timer = setInterval(() => setNowTick(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [expanded]);

  // Neither the tab nor the search text outlives the panel: the plan fixes that,
  // because a panel that remembers where you left it three weeks ago is a panel
  // you open on the wrong page. Only the *size* is remembered, and that is the
  // resize hook's business.
  useEffect(() => {
    if (expanded) return;
    setTab('chats');
    setQuery('');
  }, [expanded]);

  const panelRef = useRef<HTMLElement>(null);
  const { size, gripProps } = useResizablePanel(panelRef, expanded);
  // The Open rows' order is captured when the panel opens and held while it
  // stays open, so two running chats bumping updatedAt cannot swap rows under
  // the pointer. A ref, derived during render: `openItems` is a new array on
  // every App render, and state set from an effect on it re-rendered on every
  // streamed fragment until React gave up ("Maximum update depth exceeded").
  const openOrderRef = useRef<string[] | null>(null);
  let orderedOpenItems = openItems;
  if (expanded) {
    orderedOpenItems = orderOpenItems(openItems, openOrderRef.current ?? []);
    openOrderRef.current = orderedOpenItems.map((item) => item.id);
  } else {
    openOrderRef.current = null;
  }

  // The panel floats over the transcript now, so it needs the dismissal
  // contract every overlay needs. Same shape as the row kebab's; the kebab keeps
  // its own because it must close without closing the panel.
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      // The toolbar button toggles; letting the outside-click close fire too
      // would reopen-and-close on the same press.
      if ((target as HTMLElement).closest?.('#history-toolbar-btn')) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded, onDismiss]);

  // Chats is what is open as a tab; Archived is every closed chat. The host
  // keeps closed chats in two lists — the recent history and the overflow past
  // it — but that split is by age only, and the owner read a chat closed an
  // hour ago under "Chats" as an archived chat shown in the wrong place.
  // The host already drops overflow rows that duplicate a recent one; the id
  // check here keeps a transient overlap from drawing a row twice.
  const closedRows = useMemo(() => {
    const recentIds = new Set(items.map((item) => item.id));
    return [...items, ...archived.filter((row) => !recentIds.has(row.id))].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }, [items, archived]);
  // The badges count what a tab holds, not what the search box is leaving in: a
  // number that moved with every typed letter would read as a different panel.
  const counts: Record<PanelTab, { total: number; failing: number }> = {
    chats: { total: orderedOpenItems.length, failing: 0 },
    archived: { total: closedRows.length, failing: 0 },
    jobs: { total: jobs.length, failing: failingJobCount(jobs) },
  };

  const moveTab = (step: number): void => {
    const index = TABS.findIndex((entry) => entry.id === tab);
    const next = TABS[(index + step + TABS.length) % TABS.length]!;
    setTab(next.id);
    // Roving tabindex: only the selected tab is in the tab order, so the arrow
    // keys have to carry focus with them or the next Tab lands back on the input.
    document.getElementById(`history-tab-${next.id}`)?.focus();
  };

  const onTabListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveTab(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveTab(-1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const edge = event.key === 'Home' ? TABS[0]! : TABS[TABS.length - 1]!;
      setTab(edge.id);
      document.getElementById(`history-tab-${edge.id}`)?.focus();
    }
  };

  const panelStyle: CSSProperties | undefined = size
    ? { width: `${size.width}px`, height: `${size.height}px` }
    : undefined;

  return (
    <section
      id="history-panel"
      ref={panelRef}
      aria-label="Conversation history"
      hidden={!expanded}
      style={panelStyle}
    >
      <div className="history-panel-head">
        <input
          id="history-search"
          className="history-search"
          type="search"
          maxLength={SESSION_SEARCH_QUERY_MAX_CHARS}
          aria-label={`Search ${SEARCH_PLACEHOLDER[tab].replace(/^Search /, '').toLowerCase()}`}
          placeholder={SEARCH_PLACEHOLDER[tab]}
          title={
            tab === 'jobs'
              ? undefined
              : 'All keywords must match. Use "exact phrases" and -exclude or -"excluded phrases".'
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape inside the box clears the search before it closes the
            // panel: a person who mistyped a chat name should not have to
            // reopen the panel to fix it.
            if (event.key !== 'Escape' || !query) return;
            event.stopPropagation();
            event.preventDefault();
            setQuery('');
          }}
        />
        {tab !== 'jobs' && (
          <span className="history-search-help">All keywords · "exact phrase" · -exclude</span>
        )}
        <div
          role="tablist"
          aria-label="Panel sections"
          className="history-tablist"
          onKeyDown={onTabListKeyDown}
        >
          {TABS.map((entry) => {
            const selected = entry.id === tab;
            const count = counts[entry.id];
            // A failing job is the only count worth wearing the error colour:
            // it is the one that means something went wrong while nobody was looking.
            const shown = entry.id === 'jobs' && count.failing > 0 ? count.failing : count.total;
            return (
              <button
                key={entry.id}
                id={`history-tab-${entry.id}`}
                type="button"
                role="tab"
                className="history-tab"
                aria-selected={selected}
                aria-controls={`history-tabpanel-${entry.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(entry.id)}
              >
                <span className="history-tab-label">{entry.label}</span>
                <span
                  className={`history-tab-count${
                    entry.id === 'jobs' && count.failing > 0
                      ? ' history-tab-count--failing'
                      : entry.id === 'chats'
                        ? ' history-tab-count--chats'
                        : entry.id === 'archived'
                          ? ' history-tab-count--archived'
                          : ''
                  }`}
                  title={
                    entry.id === 'jobs' && count.failing > 0
                      ? `${count.failing} of ${count.total} jobs failing`
                      : undefined
                  }
                >
                  {shown}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {/* One scroll container for all three sections: three nested scroll boxes
          is three places to lose a row, and the Archived list used to open with
          its first row cut in half inside its own fixed height. `overflow-x:
          hidden` is the panel's promise, not a way to hide the old bar — the
          row that used to overflow has had its overflow removed in CSS too. */}
      <div
        className="history-scroll"
        id={`history-tabpanel-${tab}`}
        role="tabpanel"
        aria-labelledby={`history-tab-${tab}`}
      >
        {/* Keyed by tab: a menu left open in Archived must not still be open
            when you come back to Chats, where a different row owns that id. */}
        <HistoryTabContent
          key={tab}
          tab={tab}
          query={query}
          closed={closedRows}
          openItems={orderedOpenItems}
          activeId={activeId}
          streamingIds={streamingIds}
          queuedIds={queuedIds}
          waitingIds={waitingIds}
          jobs={jobs}
          jobsLoaded={jobsLoaded}
          contentMatches={contentSearch.ids}
          contentHits={contentSearch.hits}
          contentSearchPending={contentSearch.pending}
          contentSearchUnreadable={contentSearch.unreadable}
          nowTick={nowTick}
          onRestore={onRestore}
          onDelete={onDelete}
          onRename={onRename}
          onResetApprovals={onResetApprovals}
          onClose={onClose}
          onSetKeepOpen={onSetKeepOpen}
          onSwitchOpen={onSwitchOpen}
          onOpenJob={onOpenJob}
        />
      </div>
      {/* The grip is a child of the panel, so it sits at the panel's own corner
          rather than at the sidebar's: a panel shorter than the sidebar still
          has its resize handle where the panel ends. */}
      <span {...gripProps} />
    </section>
  );
}
