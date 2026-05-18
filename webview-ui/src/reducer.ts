import type {
  SessionTabMeta,
  SessionHistoryMeta,
  DiffHunk,
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
  messages: AppMessage[];
  streaming: boolean;
  generating: boolean;
  models: string[];
  activeModel: string | null;
  backendReady: boolean;
  checkpointPending: boolean;
  sessionHydrated: boolean;
  tabs: SessionTabMeta[];
  history: SessionHistoryMeta[];
  activeConversationId: string;
}

export type Action =
  | { type: 'TOKEN'; text: string }
  | { type: 'REASONING_TOKEN'; text: string }
  | { type: 'DONE' }
  | { type: 'ERROR'; message: string }
  | { type: 'READY' }
  | { type: 'BACKEND_STARTING'; message: string }
  | { type: 'BACKEND_DOWN'; message: string }
  | { type: 'MODELS'; names: string[]; active: string | null }
  | { type: 'USER_SEND'; text: string }
  | { type: 'SET_MODEL'; name: string | null }
  | { type: 'CHECKPOINT_READY' }
  | { type: 'CHECKPOINT_DISMISSED' }
  | { type: 'TOOL_ACTIVITY'; toolName: string; detail?: string }
  | { type: 'FILE_DIFF'; filePath: string; hunks: DiffHunk[] | null; isNew: boolean; isDeleted: boolean }
  | {
      type: 'SESSION_SYNC';
      activeId: string;
      tabs: SessionTabMeta[];
      history: SessionHistoryMeta[];
      messagesById: Record<string, Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string | undefined }>>;
    };

function mkId(): string {
  return Math.random().toString(36).slice(2);
}

export const initialState: State = {
  messages: [],
  streaming: false,
  generating: false,
  models: [],
  activeModel: null,
  backendReady: false,
  checkpointPending: false,
  sessionHydrated: false,
  tabs: [],
  history: [],
  activeConversationId: '',
};

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'USER_SEND': {
      const last = state.messages[state.messages.length - 1];
      const base =
        last?.role === 'assistant' && last.content === ''
          ? state.messages.slice(0, -1)
          : state.messages;
      return {
        ...state,
        streaming: true,
        generating: true,
        checkpointPending: false,
        messages: [...base, { id: mkId(), role: 'user', content: action.text }],
      };
    }

    case 'TOKEN': {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') {
        return {
          ...state,
          messages: [...state.messages.slice(0, -1), { ...last, content: last.content + action.text }],
        };
      }
      return {
        ...state,
        messages: [...state.messages, { id: mkId(), role: 'assistant', content: action.text }],
      };
    }

    case 'REASONING_TOKEN': {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') {
        return {
          ...state,
          messages: [
            ...state.messages.slice(0, -1),
            { ...last, reasoning: (last.reasoning ?? '') + action.text },
          ],
        };
      }
      return {
        ...state,
        messages: [...state.messages, { id: mkId(), role: 'assistant', content: '', reasoning: action.text }],
      };
    }

    case 'DONE':
      return { ...state, streaming: false, generating: false };

    case 'ERROR':
      return {
        ...state,
        streaming: false,
        generating: false,
        messages: [...state.messages, { id: mkId(), role: 'error', content: action.message }],
      };

    case 'READY':
      return {
        ...state,
        backendReady: true,
        messages: [...state.messages, { id: mkId(), role: 'system', content: 'Backend ready.' }],
      };

    case 'BACKEND_STARTING':
      return {
        ...state,
        backendReady: false,
        messages: [...state.messages, { id: mkId(), role: 'system', content: action.message }],
      };

    case 'BACKEND_DOWN':
      return {
        ...state,
        streaming: false,
        generating: false,
        backendReady: false,
        messages: [...state.messages, { id: mkId(), role: 'system', content: action.message }],
      };

    case 'MODELS':
      return { ...state, models: action.names, activeModel: action.active };

    case 'SET_MODEL':
      return { ...state, activeModel: action.name };

    case 'TOOL_ACTIVITY':
      return {
        ...state,
        messages: [...state.messages, {
          id: mkId(),
          role: 'tool' as const,
          content: action.detail ? `${action.toolName} → ${action.detail}` : action.toolName,
        }],
      };

    case 'FILE_DIFF':
      return {
        ...state,
        messages: [...state.messages, {
          id: mkId(),
          role: 'diff' as const,
          content: action.filePath,
          diffHunks: action.hunks,
          diffIsNew: action.isNew,
          diffIsDeleted: action.isDeleted,
        }],
      };

    case 'CHECKPOINT_READY':
      return { ...state, checkpointPending: true };

    case 'CHECKPOINT_DISMISSED':
      return { ...state, checkpointPending: false };

    case 'SESSION_SYNC': {
      const rows = action.messagesById[action.activeId] ?? [];
      const restored: AppMessage[] = rows.map((m) => ({
        id: mkId(),
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
      }));
      return {
        ...state,
        sessionHydrated: true,
        tabs: action.tabs,
        history: action.history,
        activeConversationId: action.activeId,
        messages: restored,
      };
    }

    default:
      return state;
  }
}
