import type {
  SessionTabMeta,
  SessionHistoryMeta,
  DiffHunk,
  ModelEntry,
} from '../../src/sidebar/messageBridge';

export interface AppMessage {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system' | 'tool' | 'diff';
  content: string;
  reasoning?: string | undefined;
  diffHunks?: DiffHunk[] | null;
  diffIsNew?: boolean;
  diffIsDeleted?: boolean;
}

interface State {
  messagesById: Record<string, AppMessage[]>;
  streamingIds: Set<string>;
  generatingIds: Set<string>;
  models: ModelEntry[];
  activeModel: string | null;
  backendReady: boolean;
  checkpointPending: boolean;
  sessionHydrated: boolean;
  tabs: SessionTabMeta[];
  history: SessionHistoryMeta[];
  activeConversationId: string;
  clankerMode: boolean;
}

/** Derived view helpers — used by App.tsx */
export function selectMessages(state: State): AppMessage[] {
  return state.messagesById[state.activeConversationId] ?? [];
}
export function selectStreaming(state: State): boolean {
  return state.streamingIds.has(state.activeConversationId);
}
export function selectGenerating(state: State): boolean {
  return state.generatingIds.has(state.activeConversationId);
}

export type Action =
  | { type: 'TOKEN'; text: string; convId?: string }
  | { type: 'REASONING_TOKEN'; text: string; convId?: string }
  | { type: 'DONE'; convId?: string }
  | { type: 'ERROR'; message: string; convId?: string }
  | { type: 'READY'; convId?: string }
  | { type: 'BACKEND_STARTING'; message: string; convId?: string }
  | { type: 'BACKEND_DOWN'; message: string; convId?: string }
  | { type: 'MODELS'; models: ModelEntry[]; active: string | null }
  | { type: 'USER_SEND'; text: string }
  | { type: 'SET_MODEL'; name: string | null }
  | { type: 'CHECKPOINT_READY'; convId?: string }
  | { type: 'CHECKPOINT_DISMISSED'; convId?: string }
  | { type: 'TOOL_ACTIVITY'; toolName: string; detail?: string; convId?: string }
  | {
      type: 'FILE_DIFF';
      filePath: string;
      hunks: DiffHunk[] | null;
      isNew: boolean;
      isDeleted: boolean;
      convId?: string;
    }
  | { type: 'CLANKER_CHANGED'; enabled: boolean }
  | {
      type: 'SESSION_SYNC';
      activeId: string;
      tabs: SessionTabMeta[];
      history: SessionHistoryMeta[];
      messagesById: Record<
        string,
        Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string | undefined }>
      >;
    };

function mkId(): string {
  return Math.random().toString(36).slice(2);
}

export const initialState: State = {
  messagesById: {},
  streamingIds: new Set(),
  generatingIds: new Set(),
  models: [],
  activeModel: null,
  backendReady: false,
  checkpointPending: false,
  sessionHydrated: false,
  tabs: [],
  history: [],
  activeConversationId: '',
  clankerMode: false,
};

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

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'USER_SEND': {
      const cid = state.activeConversationId;
      const existing = state.messagesById[cid] ?? [];
      const last = existing[existing.length - 1];
      // Strip stale diff cards and trailing empty assistant placeholder from previous turn
      const base = existing
        .filter((m) => m.role !== 'diff')
        .filter(
          (m, _i, arr) =>
            !(m.role === 'assistant' && m.content === '' && m === arr[arr.length - 1]),
        );
      void last;
      return {
        ...state,
        streamingIds: new Set([...state.streamingIds, cid]),
        generatingIds: new Set([...state.generatingIds, cid]),
        checkpointPending: false,
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
      if (last?.role === 'assistant') {
        return updateLastInConv(state, cid, (m) => ({ ...m, content: m.content + action.text }));
      }
      return appendToConv(state, cid, { id: mkId(), role: 'assistant', content: action.text });
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
      return appendToConv({ ...state, backendReady: true }, cid, {
        id: mkId(),
        role: 'system',
        content: 'Backend ready.',
      });
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

    case 'CHECKPOINT_READY':
      return { ...state, checkpointPending: true };

    case 'CHECKPOINT_DISMISSED':
      return { ...state, checkpointPending: false };

    case 'CLANKER_CHANGED':
      return { ...state, clankerMode: action.enabled };

    case 'SESSION_SYNC': {
      const messagesById: Record<string, AppMessage[]> = {};
      for (const [id, rows] of Object.entries(action.messagesById)) {
        const existing = state.messagesById[id] ?? [];
        const reconstructed = rows.map((m, i) => ({
          id: existing[i]?.role === m.role ? existing[i].id : mkId(),
          role: m.role,
          content: m.content,
          reasoning: m.reasoning,
        }));
        // Re-append any diff cards that were live in this conversation — they are not
        // persisted server-side so SESSION_SYNC would otherwise wipe them.
        const survivingDiffs = (state.messagesById[id] ?? []).filter((m) => m.role === 'diff');
        // Errors are host/UI state rather than persisted chat messages. Keep
        // them across the post-turn SESSION_SYNC so actionable failures do not
        // flash briefly and disappear during reconciliation.
        const survivingErrors = (state.messagesById[id] ?? []).filter((m) => m.role === 'error');
        messagesById[id] = [...reconstructed, ...survivingErrors, ...survivingDiffs];
      }
      return {
        ...state,
        sessionHydrated: true,
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
