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
        return updateLastInConv(state, cid, (m) => ({ ...m, content: m.content + action.text }));
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
        }));
      }
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'assistant',
        content: '',
        reasoning: action.text,
      });
    }

    case 'DONE': {
      const cid = resolveConvId(state, action.convId);
      const newStreaming = new Set(state.streamingIds);
      const newGenerating = new Set(state.generatingIds);
      newStreaming.delete(cid);
      newGenerating.delete(cid);
      return { ...state, streamingIds: newStreaming, generatingIds: newGenerating };
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
      return appendToConv(
        { ...clearRecoveredBackendStartErrors(state, cid), backendReady: true },
        cid,
        {
          id: mkId(),
          role: 'system',
          content: 'Backend ready.',
        },
      );
    }

    case 'BACKEND_STARTING': {
      const cid = resolveConvId(state, action.convId);
      return appendToConv({ ...state, backendReady: false }, cid, {
        id: mkId(),
        role: 'system',
        content: action.message,
      });
    }

    case 'BACKEND_DOWN': {
      const cid = resolveConvId(state, action.convId);
      const newStreaming = new Set(state.streamingIds);
      const newGenerating = new Set(state.generatingIds);
      newStreaming.delete(cid);
      newGenerating.delete(cid);
      return appendToConv(
        { ...state, streamingIds: newStreaming, generatingIds: newGenerating, backendReady: false },
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
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'tool' as const,
        content: action.detail ? `${action.toolName} → ${action.detail}` : action.toolName,
        toolName: action.toolName,
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
      const messagesById: Record<string, AppMessage[]> = {};
      for (const [id, rows] of Object.entries(action.messagesById)) {
        messagesById[id] = mergeSyncedMessages(state.messagesById[id] ?? [], rows);
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
      const hostStreaming = action.tabs.filter((tab) => tab.streaming).map((tab) => tab.id);
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
