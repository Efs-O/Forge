/**
 * The sessions panel's search box on the side that cannot read transcripts.
 *
 * Titles and sender badges are matched in `historyFilter.ts` from the rows the
 * webview already has. What it cannot do is read the saved chats — the archive
 * this machine holds is 211 bodies and 354 session logs, ~400 MB — so the box
 * asks the host, and the host walks them (`src/sidebar/sessionContentSearch.ts`).
 * This file owns only the asking: when to ask, which reply is still current, and
 * what to show while the answer has not come back.
 *
 * Three things make a reply stale, and all three are guarded here rather than
 * trusted from the host: a newer query (typing `clau` then `claude` sent two
 * requests), a tab change (Chats and Archived search different sets), and a
 * panel that closed or reopened (`panelId` is the panel generation App hands
 * down, and 0 means there is no open panel to answer). A dropped guard would
 * paint an older query's matches over what the person is looking at, which is
 * the failure this whole path exists to avoid.
 *
 * The debounce lives here because only the webview knows when typing stopped;
 * the length is the host's constant, imported rather than retyped, so the two
 * sides and the tests cannot drift apart.
 */
import { useEffect, useRef, useState } from 'react';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import {
  SESSION_SEARCH_DEBOUNCE_MS,
  type SessionSearchTab,
  type SessionSearchHit,
} from '../../src/sidebar/sessionSearchMessages';
import { vscode } from './vscode';

/** What the host has said about the text currently in the box. */
export interface ContentSearchState {
  /** Conversations whose saved text matched. The panel filters its rows against these ids. */
  ids: ReadonlySet<string>;
  hits: ReadonlyMap<string, SessionSearchHit>;
  /**
   * True from the moment a query is typed until the host says it has walked
   * everything: while it is true the panel must not report a no-match, because
   * the chats that would have matched have not been read yet.
   */
  pending: boolean;
  /** Archived chats the host could not read, so an empty result is not proof of absence. */
  unreadable: number;
}

/** What a closed panel, a Jobs tab, or an empty box has: nothing searched, and nothing pending. */
const NOTHING_SEARCHED: ContentSearchState = {
  ids: new Set<string>(),
  hits: new Map(),
  pending: false,
  unreadable: 0,
};

/** The newest request this panel sent; only that request's reply may be applied. */
interface PendingRequest {
  panelId: number;
  requestId: number;
  tab: SessionSearchTab;
  query: string;
}

export function useSessionContentSearch(args: {
  /** The panel generation App is holding; 0 means the panel is closed. */
  panelId: number;
  /** Which tab the box is filtering, because the two tabs search different chats. */
  tab: 'chats' | 'archived' | 'jobs';
  query: string;
}): ContentSearchState {
  const { panelId, tab, query } = args;
  const [state, setState] = useState<ContentSearchState>(NOTHING_SEARCHED);
  // A ref, not state: the reply guard has to be readable from the message
  // handler without re-subscribing on every keystroke.
  const currentRequest = useRef<PendingRequest | undefined>(undefined);
  const sequence = useRef(0);

  useEffect(() => {
    if (!panelId || tab === 'jobs' || !query.trim()) {
      // Nothing to ask. A refetch on every render is avoided by handing out the
      // same object every time: React does not re-render for an identical value.
      currentRequest.current = undefined;
      setState(NOTHING_SEARCHED);
      return;
    }
    // A search is running the moment the text changes, before the debounce has
    // fired and before the host has read a single chat, so the panel says
    // "searching" rather than "nothing matches" across the whole gap.
    setState({ ids: new Set<string>(), hits: new Map(), pending: true, unreadable: 0 });
    const timer = setTimeout(() => {
      const requestId = ++sequence.current;
      const request: PendingRequest = { panelId, requestId, tab, query };
      currentRequest.current = request;
      vscode.postMessage({
        type: 'sessionSearchQuery',
        panelId,
        requestId,
        tab,
        query,
      });
    }, SESSION_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      const active = currentRequest.current;
      if (active) {
        // Stop disk reads immediately, including when the next tab is Jobs or
        // the box is cleared and no replacement search will be sent.
        vscode.postMessage({ type: 'sessionSearchQuery', ...active, query: '' });
      }
      // This text is no longer what is in the box, so any answer on its way —
      // a first publish, or a later pass of the same query — is stale from here.
      currentRequest.current = undefined;
    };
  }, [panelId, tab, query]);

  useEffect(() => {
    if (!panelId) return;
    const handler = (event: MessageEvent): void => {
      const message = event.data as HostToWebview;
      if (message.type !== 'sessionSearchResult') return;
      const expected = currentRequest.current;
      // Every field has to name what this panel asked about. `query` is echoed
      // by the host precisely so a reply cannot be accepted on id alone.
      if (
        !expected ||
        message.panelId !== expected.panelId ||
        message.requestId !== expected.requestId ||
        message.tab !== expected.tab ||
        message.query !== expected.query
      )
        return;
      // Replace, never merge: every publish carries the whole set the scan has
      // reached for this request, so a missed publish cannot leave half a result.
      setState({
        ids: new Set(message.ids),
        hits: new Map(message.hits?.map((hit) => [hit.id, hit])),
        pending: !message.complete,
        unreadable: message.unreadable ?? 0,
      });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [panelId]);

  return state;
}
