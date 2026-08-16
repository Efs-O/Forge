import type {
  SessionTabMeta,
  SessionHistoryMeta,
  DiffHunk,
  ModelEntry,
} from '../../src/sidebar/messageBridge';
import type { AppMessage, PersistedRow } from './messageOps';

export interface State {
  messagesById: Record<string, AppMessage[]>;
  streamingIds: Set<string>;
  generatingIds: Set<string>;
  models: ModelEntry[];
  activeModel: string | null;
  backendReady: boolean;
  /**
   * Conversations with an undismissed checkpoint. Keyed per conversation because
   * the bar is a property of one turn in one tab — a single global flag leaked a
   * pending checkpoint into every other tab.
   */
  checkpointPendingIds: Set<string>;
  sessionHydrated: boolean;
  tabs: SessionTabMeta[];
  history: SessionHistoryMeta[];
  activeConversationId: string;
  clankerMode: boolean;
}

export const initialState: State = {
  messagesById: {},
  streamingIds: new Set(),
  generatingIds: new Set(),
  models: [],
  activeModel: null,
  backendReady: false,
  checkpointPendingIds: new Set(),
  sessionHydrated: false,
  tabs: [],
  history: [],
  activeConversationId: '',
  clankerMode: false,
};

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
export function selectCheckpointPending(state: State): boolean {
  return state.checkpointPendingIds.has(state.activeConversationId);
}

export type Action =
  | { type: 'TOKEN'; text: string; convId?: string }
  | { type: 'NOTICE'; message: string; convId?: string }
  | { type: 'REASONING_TOKEN'; text: string; convId?: string }
  | { type: 'GENERATION_STARTED'; convId?: string }
  | { type: 'DONE'; convId?: string }
  | { type: 'ERROR'; message: string; convId?: string }
  | { type: 'READY'; convId?: string }
  | { type: 'BACKEND_STARTING'; message: string; convId?: string }
  | { type: 'BACKEND_DOWN'; message: string; convId?: string }
  | { type: 'MODELS'; models: ModelEntry[]; active: string | null }
  | { type: 'USER_SEND'; text: string; convId?: string }
  | { type: 'SET_MODEL'; name: string | null }
  | { type: 'CHECKPOINT_READY'; convId?: string }
  | { type: 'CHECKPOINT_DISMISSED'; convId?: string }
  | { type: 'TOOL_ACTIVITY'; toolName: string; detail?: string; convId?: string }
  | {
      type: 'TOOL_RESULT';
      toolName: string;
      label: string;
      text: string;
      totalChars: number;
      filePath?: string;
      isError?: boolean;
      convId?: string;
    }
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
      messagesById: Record<string, PersistedRow[]>;
    };
