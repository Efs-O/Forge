import { mergeSyncedMessages, type AppMessage } from './messageOps';
import type { Action, State } from './appState';

/** Reconcile the host's partial session snapshot with the webview's live cache. */
export function applySessionSync(
  state: State,
  action: Extract<Action, { type: 'SESSION_SYNC' }>,
): State {
  const hostStreaming = action.tabs.filter((tab) => tab.streaming).map((tab) => tab.id);
  const liveConversationIds = new Set([...state.streamingIds, ...hostStreaming]);
  // `messagesById` is a PARTIAL update — the host ships only the transcripts
  // that can be rendered right now (active + streaming + anything asked for),
  // because shipping all 52 was costing a second per tab switch. An absent id
  // means "unchanged", never "empty".
  const messagesById: Record<string, AppMessage[]> = { ...state.messagesById };
  const syncedIds = new Set(state.syncedIds);
  for (const [id, rows] of Object.entries(action.messagesById)) {
    const local = state.messagesById[id] ?? [];
    // Stream tokens and tool events are the newest presentation state. A
    // periodic host checkpoint can be older; hydrate an empty/restored webview,
    // but keep an established live transcript until DONE. A cache that only
    // holds live rows - a prompt that reached a chat evicted below - is not
    // established while the host has more rows: keeping it hid the history.
    const established = state.syncedIds.has(id) || rows.length <= local.length;
    messagesById[id] =
      liveConversationIds.has(id) && local.length > 0 && established
        ? local
        : mergeSyncedMessages(local, rows, action.attachmentsRoot);
    syncedIds.add(id);
  }
  // Keep the visible active id even during a partial tab-list reconciliation,
  // so an undo the reader can still see files for is never stranded.
  const openIds = new Set([...action.tabs.map((tab) => tab.id), action.activeId]);
  const pending = new Set([...state.checkpointPendingIds].filter((id) => openIds.has(id)));
  // A closed conversation is re-sent if it is shown again; bound this cache to
  // open tabs for the lifetime of the webview.
  for (const id of Object.keys(messagesById)) {
    if (!openIds.has(id)) delete messagesById[id];
  }
  for (const id of syncedIds) {
    if (!(id in messagesById)) syncedIds.delete(id);
  }
  return {
    ...state,
    sessionHydrated: true,
    streamingIds: new Set([...state.streamingIds, ...hostStreaming]),
    generatingIds: new Set([...state.generatingIds, ...hostStreaming]),
    checkpointPendingIds:
      pending.size === state.checkpointPendingIds.size ? state.checkpointPendingIds : pending,
    tabs: action.tabs,
    history: action.history,
    archived: action.archived,
    activeConversationId: action.activeId,
    messagesById,
    syncedIds,
  };
}
