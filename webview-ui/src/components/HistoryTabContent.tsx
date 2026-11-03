/**
 * What one tab of the sessions panel shows: its rows, and the empty or
 * no-match line that stands in for them.
 *
 * Split out of `HistoryList.tsx`, which is the panel's shell — search box, tab
 * strip, the one scroll container, the resize grip, dismissal — and would
 * otherwise carry both jobs at once past this repo's 350-line split point. The
 * row-management state (one menu, one rename at a time) lives here with the
 * rows it names; the shell never sees a row id.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import type {
  JobPanelMeta,
  SessionHistoryMeta,
  SessionTabMeta,
} from '../../../src/sidebar/messageBridge';
import { filterChatRows, filterJobRows, noMatchMessage } from '../historyFilter';
import { HistoryChatRow, HistoryOpenRow } from './HistoryChatRow';
import { HistoryJobRow } from './HistoryJobRow';

/** The three sections the panel shows as tabs rather than as three scroll boxes. */
export type PanelTab = 'chats' | 'archived' | 'jobs';

export interface HistoryTabContentProps {
  tab: PanelTab;
  /** The search box's text. Empty means show everything. */
  query: string;
  /** Every closed chat — recent history and older overflow — newest first. */
  closed: SessionHistoryMeta[];
  /** The open tabs, already in the order the panel captured when it opened. */
  openItems: SessionTabMeta[];
  activeId: string;
  streamingIds: ReadonlySet<string>;
  queuedIds: ReadonlySet<string>;
  waitingIds: ReadonlySet<string>;
  jobs: JobPanelMeta[];
  jobsLoaded: boolean;
  /**
   * Ids the host reported for saved text that matches the box. Empty and
   * `contentSearchPending` false is a complete answer; pending true means the
   * walk is still going and an empty set proves nothing yet.
   */
  contentMatches: ReadonlySet<string>;
  /** True while the host has not finished reading the chats this tab shows. */
  contentSearchPending: boolean;
  /** Archived chats the host could not read; a no-match must not be read as proof. */
  contentSearchUnreadable?: number;
  /** The minute the relative labels were last drawn. */
  nowTick: Date;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onResetApprovals: (id: string) => void;
  onClose: (id: string) => void;
  onSetKeepOpen: (id: string, keepOpen: boolean) => void;
  onSwitchOpen?: (id: string) => void;
  onOpenJob: (id: string) => void;
}

export function HistoryTabContent({
  tab,
  query,
  closed,
  openItems,
  activeId,
  streamingIds,
  queuedIds,
  waitingIds,
  jobs,
  jobsLoaded,
  contentMatches,
  contentSearchPending,
  contentSearchUnreadable = 0,
  nowTick,
  onRestore,
  onDelete,
  onRename,
  onResetApprovals,
  onClose,
  onSetKeepOpen,
  onSwitchOpen,
  onOpenJob,
}: HistoryTabContentProps): ReactElement {
  // Only one row may be open or editing at a time, so both live here as an id
  // rather than as per-row state that would survive the row being re-keyed.
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const searching = query.trim() !== '';

  const chatRows = (rows: SessionHistoryMeta[], listId: string): ReactElement => (
    <div id={listId}>
      {rows.map((item) => (
        <HistoryChatRow
          key={item.id}
          item={item}
          renaming={renamingId === item.id}
          menuOpen={menuId === item.id}
          onOpenMenu={setMenuId}
          onStartRename={setRenamingId}
          onRestore={onRestore}
          onDelete={onDelete}
          onRename={onRename}
          onResetApprovals={onResetApprovals}
        />
      ))}
    </div>
  );

  const noMatch = (): ReactElement => <p id="history-no-match">{noMatchMessage(query)}</p>;

  /**
   * What to say when this tab has nothing to draw for the text typed.
   *
   * The host has not finished reading the saved chats, so an empty result here
   * is not yet a no-match: saying one would tell the person their chat does not
   * contain the words, a second before the scan reaches that chat. The loading
   * line replaces it until the walk completes.
   */
  const noMatchOrSearching = (): ReactElement =>
    contentSearchPending ? (
      <p id="history-search-pending">Searching saved chats…</p>
    ) : (
      /* A no-match with chats the scan could not open is a weaker claim than a
       * clean one, so the line that says it has to say which of the two it is. */
      <>
        {noMatch()}
        {searchFootnote()}
      </>
    );

  /** What a result that is still growing, or missing chats it could not read, has to admit. */
  const searchFootnote = (): ReactElement | null => {
    if (contentSearchPending)
      return <p id="history-search-partial">Still searching saved chats…</p>;
    if (contentSearchUnreadable > 0)
      return (
        <p id="history-search-unreadable">
          Search could not read {contentSearchUnreadable} saved
          {contentSearchUnreadable === 1 ? ' chat' : ' chats'}.
        </p>
      );
    return null;
  };

  if (tab === 'jobs') {
    const rows = filterJobRows(jobs, query);
    if (rows.length > 0)
      return (
        <div id="history-jobs-list">
          {rows.map((job) => (
            <HistoryJobRow
              key={job.id}
              job={job}
              now={nowTick}
              running={
                job.runningConversationId !== null && streamingIds.has(job.runningConversationId)
              }
              onOpen={onOpenJob}
            />
          ))}
        </div>
      );
    // A search that matches nothing says so, rather than claiming the store is
    // empty. An unsearched empty store still says `No jobs yet.`, and a panel
    // the host has not answered still says it is loading.
    if (jobs.length > 0 && searching) return noMatch();
    return <p id="history-jobs-empty">{jobsLoaded ? 'No jobs yet.' : 'Loading jobs…'}</p>;
  }

  if (tab === 'archived') {
    const rows = filterChatRows(closed, query, contentMatches);
    if (rows.length > 0)
      return (
        <>
          {chatRows(rows, 'history-list')}
          {searchFootnote()}
        </>
      );
    if (closed.length > 0 && searching) return noMatchOrSearching();
    return <p id="history-archive-empty">Nothing archived yet.</p>;
  }

  const openRows = filterChatRows(openItems, query, contentMatches);
  if (openRows.length === 0) {
    // Nothing to show and nothing searched is the panel's own empty state;
    // nothing to show *because* of a search is the search's answer.
    if (openItems.length === 0) return <p id="history-empty">No open chats.</p>;
    return noMatchOrSearching();
  }
  return (
    <>
      {openRows.length > 0 && (
        <div id="history-open-list">
          {openRows.map((item) => (
            <HistoryOpenRow
              key={item.id}
              item={item}
              active={item.id === activeId}
              live={
                streamingIds.has(item.id)
                  ? 'running'
                  : waitingIds.has(item.id)
                    ? 'waiting'
                    : queuedIds.has(item.id)
                      ? 'queued'
                      : 'open'
              }
              onSwitch={(id) => (onSwitchOpen ?? onRestore)(id)}
              onClose={onClose}
              onSetKeepOpen={onSetKeepOpen}
            />
          ))}
        </div>
      )}
      {openRows.length > 0 && searching && searchFootnote()}
    </>
  );
}
