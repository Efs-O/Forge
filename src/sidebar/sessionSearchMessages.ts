/**
 * The wire shapes for the sessions panel's content search, mirrored for
 * host + webview the way `jobPanelMessages.ts` and `sessionMetaMessages.ts`
 * are: `messageBridge.ts` stays the single import for every message shape by
 * re-exporting these, and the declarations live with the concern they belong to.
 *
 * Panel-scoped, not conversation-scoped, for the same reason the Jobs section
 * is: `panelId` is the webview's open-panel generation and `requestId` is this
 * panel's query counter. A reply is only applied when both still name the panel
 * that is open and the query that is typed, so rapid typing, a tab change, a
 * close/reopen and a window reload can each only paint over themselves.
 *
 * The scan is deliberately not one instant answer. An archive this size (hundreds
 * of bodies and session logs, measured at ~400 MB in this workspace) cannot be
 * read inside one keystroke, so the host publishes what it has found so far and
 * keeps going: `complete` is false while the scan is still walking, and the panel
 * shows "still searching" rather than a no-match it has not earned.
 *
 * No Zod here, on purpose: this file is imported by the webview, and a schema
 * would pull the whole validation library into the panel's bundle for one
 * message. The shapes are types only; the contract a query has to satisfy is
 * enforced where it is acted on, in `sessionContentSearch.ts`.
 */

/** The two tabs that hold chats. Jobs search stays in the webview's own list. */
export type SessionSearchTab = 'chats' | 'archived';

/** A bounded preview and shared relevance score; no full transcript crosses the bridge. */
export interface SessionSearchHit {
  id: string;
  score: number;
  snippet?: string;
}

/**
 * How long the webview waits after the last keystroke before it asks the host.
 * Owned here so both sides and the tests read one number; the timer itself is
 * the webview's, because only it knows when typing stopped.
 */
export const SESSION_SEARCH_DEBOUNCE_MS = 200;

/**
 * The longest needle a scan will walk. The box is a single-line search input, so
 * a query past this is a paste of a whole transcript rather than a search, and
 * walking 400 MB of archive for it would be the answer to nobody's question.
 * The request is refused rather than silently cut: a truncated needle would
 * report matches that were never asked for.
 */
export const SESSION_SEARCH_QUERY_MAX_CHARS = 512;
/** The panel opened, or the search box changed, for one of the chat tabs. */
export interface SessionSearchQueryMsg {
  type: 'sessionSearchQuery';
  /** The webview's open-panel generation, shared with the Jobs section. */
  panelId: number;
  /** This panel's query counter, so a late reply to an older query cannot land. */
  requestId: number;
  tab: SessionSearchTab;
  /** Exactly what was typed; the host parses keywords, phrases and exclusions. */
  query: string;
}

/**
 * What the scan has found for one query so far.
 *
 * `ids` is cumulative for this `requestId`: every pass publishes the whole set
 * it has reached, so the webview replaces rather than merges, and a dropped
 * publish cannot leave half a result behind. `query` is echoed so the webview
 * can refuse a reply for text that is no longer in the box.
 */
export interface SessionSearchResultMsg {
  type: 'sessionSearchResult';
  panelId: number;
  requestId: number;
  tab: SessionSearchTab;
  query: string;
  /** Conversations satisfying the full query, in the order the scan reached them. */
  ids: string[];
  /** Scores and previews for matching ids; omitted when there are no matches. */
  hits?: SessionSearchHit[];
  /** False while the scan is still walking the archive; the panel says so. */
  complete: boolean;
  /** Archived chats this scan could not read, so a no-match is not taken as proof. */
  unreadable?: number;
}
