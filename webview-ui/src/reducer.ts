import { findPendingToolRow, mergeSyncedMessages, mkId, type AppMessage } from './messageOps';
import type { Action, State } from './appState';

export type { AppMessage } from './messageOps';
export type { Action, State } from './appState';
export {
  initialState,
  selectMessages,
  selectStreaming,
  selectGenerating,
  selectCheckpointPending,
} from './appState';

function appendToConv(state: State, convId: string, msg: AppMessage): State {
  const existing = state.messagesById[convId] ?? [];
  return { ...state, messagesById: { ...state.messagesById, [convId]: [...existing, msg] } };
}

function updateLastInConv(
  state: State,
  convId: string,
  updater: (last: AppMessage) => AppMessage,
): State {
  const existing = state.messagesById[convId] ?? [];
  if (existing.length === 0) return state;
  const updated = [...existing.slice(0, -1), updater(existing[existing.length - 1]!)];
  return { ...state, messagesById: { ...state.messagesById, [convId]: updated } };
}

function resolveConvId(state: State, convId?: string): string {
  return convId ?? state.activeConversationId;
}

function withoutKey<V>(map: Map<string, V>, id: string): Map<string, V> {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

function withoutId(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

function clearRecoveredBackendStartErrors(state: State, convId: string): State {
  const existing = state.messagesById[convId] ?? [];
  const remaining = existing.filter(
    (message) =>
      message.role !== 'error' ||
      !(
        message.content.startsWith('Backend failed to start:') ||
        message.content === 'Backend start cancelled.'
      ),
  );
  if (remaining.length === existing.length) return state;
  return { ...state, messagesById: { ...state.messagesById, [convId]: remaining } };
}

/**
 * Close an open reasoning span on the conversation's last row.
 *
 * A reasoning-only round ends at a tool call, not at prose, so `TOKEN` alone
 * would leave every thinking-then-tool round unmeasured - which on this agent
 * loop is most of them.
 */
function sealReasoningSpan(state: State, cid: string): State {
  const rows = state.messagesById[cid] ?? [];
  const last = rows[rows.length - 1];
  if (last?.role !== 'assistant') return state;
  if (last.reasoningStartedAt === undefined || last.reasoningMs !== undefined) return state;
  return updateLastInConv(state, cid, (m) => ({
    ...m,
    reasoningMs: Date.now() - (m.reasoningStartedAt ?? Date.now()),
  }));
}

/**
 * ` · 2.1 s` for a wait worth reporting, and nothing at all for one that is not.
 *
 * The row only exists when the acquire ran past BACKEND_START_NOTICE_MS, so
 * every one of these is at least half a second; the floor here guards the case
 * where the READY frame follows almost immediately after, where a duration says
 * less than no duration would.
 */
function elapsedSuffix(ms: number): string {
  if (!Number.isFinite(ms) || ms < 500) return '.';
  const s = ms / 1000;
  return ` · ${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'GENERATION_STARTED': {
      const cid = resolveConvId(state, action.convId);
      return {
        ...state,
        streamingIds: new Set([...state.streamingIds, cid]),
        generatingIds: new Set([...state.generatingIds, cid]),
      };
    }

    case 'USER_SEND': {
      const cid = resolveConvId(state, action.convId);
      const existing = state.messagesById[cid] ?? [];
      const last = existing[existing.length - 1];
      // Strip stale diff cards and trailing empty assistant placeholder from previous turn
      const base = existing
        .filter((m) => m.role !== 'diff')
        // A new prompt is an explicit retry or a model switch. The previous
        // provider failure remains useful until then, but must not look like
        // it is being replayed by the newly selected model.
        .filter((m) => m.role !== 'error')
        .filter(
          (m, _i, arr) =>
            !(m.role === 'assistant' && m.content === '' && m === arr[arr.length - 1]),
        );
      void last;
      return {
        ...state,
        streamingIds: new Set([...state.streamingIds, cid]),
        generatingIds: new Set([...state.generatingIds, cid]),
        checkpointPendingIds: withoutId(state.checkpointPendingIds, cid),
        messagesById: {
          ...state.messagesById,
          [cid]: [...base, { id: mkId(), role: 'user', content: action.text }],
        },
      };
    }

    case 'TOKEN': {
      const cid = resolveConvId(state, action.convId);
      const existing = state.messagesById[cid] ?? [];
      const last = existing[existing.length - 1];
      // The final round commonly streams reasoning before answer text. Keep
      // that reasoning as its own Thinking row instead of converting it into
      // a normal assistant bubble (which does not render `reasoning`).
      if (last?.role === 'assistant' && last.content === '' && last.reasoning) {
        return appendToConv(state, cid, { id: mkId(), role: 'assistant', content: action.text });
      }
      if (last?.role === 'assistant') {
        return updateLastInConv(state, cid, (m) => ({
          ...m,
          content: m.content + action.text,
          // Prose starting is the end of the reasoning phase. Stamped once:
          // every later token would otherwise re-measure to "now".
          ...(m.reasoningStartedAt !== undefined && m.reasoningMs === undefined
            ? { reasoningMs: Date.now() - m.reasoningStartedAt }
            : {}),
        }));
      }
      return appendToConv(state, cid, { id: mkId(), role: 'assistant', content: action.text });
    }

    case 'NOTICE': {
      const cid = resolveConvId(state, action.convId);
      return appendToConv(state, cid, { id: mkId(), role: 'system', content: action.message });
    }

    case 'REASONING_TOKEN': {
      const cid = resolveConvId(state, action.convId);
      const existing = state.messagesById[cid] ?? [];
      const last = existing[existing.length - 1];
      if (last?.role === 'assistant') {
        return updateLastInConv(state, cid, (m) => ({
          ...m,
          reasoning: (m.reasoning ?? '') + action.text,
          reasoningStartedAt: m.reasoningStartedAt ?? Date.now(),
        }));
      }
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'assistant',
        content: '',
        reasoning: action.text,
        reasoningStartedAt: Date.now(),
      });
    }

    case 'DONE': {
      const cid = resolveConvId(state, action.convId);
      const newStreaming = new Set(state.streamingIds);
      const newGenerating = new Set(state.generatingIds);
      newStreaming.delete(cid);
      newGenerating.delete(cid);
      // A turn that ends on reasoning alone - cancelled, or cut off by the
      // output budget - still gets its span closed here rather than left open.
      return {
        ...sealReasoningSpan(state, cid),
        streamingIds: newStreaming,
        generatingIds: newGenerating,
      };
    }

    case 'ERROR': {
      const cid = resolveConvId(state, action.convId);
      const newStreaming = new Set(state.streamingIds);
      const newGenerating = new Set(state.generatingIds);
      newStreaming.delete(cid);
      newGenerating.delete(cid);
      return appendToConv(
        { ...state, streamingIds: newStreaming, generatingIds: newGenerating },
        cid,
        { id: mkId(), role: 'error', content: action.message },
      );
    }

    case 'READY': {
      const cid = resolveConvId(state, action.convId);
      // The flag flips either way — it drives the composer placeholder and the
      // recovered-error sweep, neither of which depends on a row being shown.
      const next: State = {
        ...clearRecoveredBackendStartErrors(state, cid),
        backendReady: true,
        backendStartRowIds: withoutKey(state.backendStartRowIds, cid),
      };
      const start = state.backendStartRowIds.get(cid);
      if (start === undefined) return next;
      // Rewrite the announcement rather than answering it. The pair used to
      // accumulate, leaving "Starting backend, please wait…" in the transcript
      // forever above a "Backend ready." that had made it untrue.
      const content = `Backend ready${elapsedSuffix(Date.now() - start.startedAt)}`;
      return {
        ...next,
        messagesById: {
          ...next.messagesById,
          [cid]: (next.messagesById[cid] ?? []).map((row) =>
            row.id === start.id ? { ...row, content } : row,
          ),
        },
      };
    }

    case 'BACKEND_STARTING': {
      const cid = resolveConvId(state, action.convId);
      const rowId = mkId();
      return appendToConv(
        {
          ...state,
          backendReady: false,
          backendStartRowIds: new Map(state.backendStartRowIds).set(cid, {
            id: rowId,
            startedAt: Date.now(),
          }),
        },
        cid,
        { id: rowId, role: 'system', content: action.message },
      );
    }

    case 'BACKEND_DOWN': {
      const cid = resolveConvId(state, action.convId);
      const newStreaming = new Set(state.streamingIds);
      const newGenerating = new Set(state.generatingIds);
      newStreaming.delete(cid);
      newGenerating.delete(cid);
      return appendToConv(
        {
          ...state,
          streamingIds: newStreaming,
          generatingIds: newGenerating,
          backendReady: false,
          // The failure row is the answer to the announcement; a later READY
          // must not also reply to it.
          backendStartRowIds: withoutKey(state.backendStartRowIds, cid),
        },
        cid,
        { id: mkId(), role: 'error', content: action.message },
      );
    }

    case 'MODELS':
      return { ...state, models: action.models, activeModel: action.active };

    case 'SET_MODEL':
      return { ...state, activeModel: action.name };

    case 'TOOL_ACTIVITY': {
      const cid = resolveConvId(state, action.convId);
      return appendToConv(sealReasoningSpan(state, cid), cid, {
        id: mkId(),
        role: 'tool' as const,
        content: action.detail ? `${action.toolName} → ${action.detail}` : action.toolName,
        toolName: action.toolName,
        ...(action.detail ? { toolDetail: action.detail } : {}),
        ...(action.toolCallId ? { toolCallId: action.toolCallId } : {}),
      });
    }

    case 'TOOL_RESULT': {
      const cid = resolveConvId(state, action.convId);
      const existing = state.messagesById[cid] ?? [];
      const filled = {
        toolResult: action.text,
        toolResultTotal: action.totalChars,
        ...(action.filePath ? { toolFilePath: action.filePath } : {}),
        ...(action.isError ? { toolIsError: true } : {}),
      };
      // Upgrade the pending activity row for this call rather than adding a
      // second row — one line per tool call, gaining its result when it lands.
      const pending = findPendingToolRow(existing, action.toolName, action.toolCallId);
      if (pending >= 0) {
        const updated = [...existing];
        updated[pending] = {
          ...existing[pending]!,
          content: `${action.toolName} → ${action.label}`,
          ...(existing[pending]!.toolDetail !== undefined
            ? { toolDetail: existing[pending]!.toolDetail }
            : {}),
          ...filled,
        };
        return { ...state, messagesById: { ...state.messagesById, [cid]: updated } };
      }
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'tool' as const,
        content: `${action.toolName} → ${action.label}`,
        toolName: action.toolName,
        ...filled,
      });
    }

    case 'FILE_DIFF': {
      const cid = resolveConvId(state, action.convId);
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'diff' as const,
        content: action.filePath,
        diffHunks: action.hunks,
        diffIsNew: action.isNew,
        diffIsDeleted: action.isDeleted,
      });
    }

    case 'CHECKPOINT_READY': {
      const cid = resolveConvId(state, action.convId);
      return {
        ...state,
        checkpointPendingIds: new Set([...state.checkpointPendingIds, cid]),
      };
    }

    case 'CHECKPOINT_DISMISSED': {
      const cid = resolveConvId(state, action.convId);
      return { ...state, checkpointPendingIds: withoutId(state.checkpointPendingIds, cid) };
    }

    case 'CLANKER_CHANGED':
      return { ...state, clankerMode: action.enabled };

    case 'SESSION_SYNC': {
      const hostStreaming = action.tabs.filter((tab) => tab.streaming).map((tab) => tab.id);
      const liveConversationIds = new Set([...state.streamingIds, ...hostStreaming]);
      const messagesById: Record<string, AppMessage[]> = {};
      for (const [id, rows] of Object.entries(action.messagesById)) {
        const local = state.messagesById[id] ?? [];
        // Stream tokens and tool events are the newest presentation state. A
        // periodic host checkpoint can have been serialized before the latest
        // webview events arrive; reconciling that older snapshot used to make
        // an open Thinking trace shrink or disappear until the final sync.
        // Hydrate an empty/restored webview, but never replace an established
        // live transcript. DONE removes the id so the settled sync becomes
        // authoritative again.
        messagesById[id] =
          liveConversationIds.has(id) && local.length > 0
            ? local
            : mergeSyncedMessages(local, rows);
      }
      // A closed tab can never show its bar again, so drop its pending id rather
      // than letting the set grow for the lifetime of the webview.
      // The active id is retained unconditionally: a sync can report an empty tab
      // list mid-reconciliation, and dropping the visible bar there would strand
      // an undo the user can still see files for.
      const openIds = new Set([...action.tabs.map((tab) => tab.id), action.activeId]);
      const pending = new Set([...state.checkpointPendingIds].filter((id) => openIds.has(id)));
      // A restored webview may have missed generationStarted. Recover host-busy
      // tabs without clearing newer local starts; DONE remains the end signal.
      return {
        ...state,
        sessionHydrated: true,
        streamingIds: new Set([...state.streamingIds, ...hostStreaming]),
        generatingIds: new Set([...state.generatingIds, ...hostStreaming]),
        checkpointPendingIds:
          pending.size === state.checkpointPendingIds.size ? state.checkpointPendingIds : pending,
        tabs: action.tabs,
        history: action.history,
        activeConversationId: action.activeId,
        messagesById,
      };
    }

    default:
      return state;
  }
}
