import type { CheckpointStats } from '../../src/sidebar/diffMessages';
import type { PendingToolCalls } from './pendingToolCalls';
import type {
  SessionTabMeta,
  SessionHistoryMeta,
  DiffHunk,
  ModelEntry,
} from '../../src/sidebar/messageBridge';
import type { AppMessage, MessageAttachment, PersistedRow } from './messageOps';
import type { AgentSenderMetadata } from '../../src/agentLinks/chatAgentLinks';
import type { ActivityViewMode } from './activityRows';
import type { ThinkingDisplayMode } from '../../src/sidebar/activityViewSetting';

export interface State {
  messagesById: Record<string, AppMessage[]>;
  /** Conversations whose cached rows were hydrated from a host sync (`sessionSyncReducer.ts`). */
  syncedIds: ReadonlySet<string>;
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
  /**
   * The host's net change for each conversation's newest checkpoint. Read only
   * while the id is in `checkpointPendingIds`, so a dismissed entry is inert.
   */
  checkpointStatsById: Map<string, CheckpointStats>;
  /**
   * Conversation id -> its "Starting backend…" row, and when that row landed.
   *
   * Only conversations that announced a start are in here: a warm pool resolves
   * the acquire in milliseconds and announces nothing, and an unconditional
   * reply would leave a permanent row answering a question nobody asked. The
   * row id is kept so `READY` can rewrite that row in place rather than append
   * a second one - a wait that ended does not need two permanent rows, one of
   * which describes a state that is over. `startedAt` rides along so the
   * rewrite can say how long the wait actually was - a cold llama-server spawn
   * plus a model load is the slowest thing in a session, and "Backend ready."
   * on its own throws that measurement away.
   */
  backendStartRowIds: Map<string, { id: string; startedAt: number }>;
  sessionHydrated: boolean;
  tabs: SessionTabMeta[];
  history: SessionHistoryMeta[];
  archived: SessionHistoryMeta[];
  activeConversationId: string;
  clankerMode: boolean;
  /** Whether anything outside this window can drive it. Host-owned. */
  remote: { transports: string[]; paired: boolean };
  activityView: ActivityViewMode;
  thinkingDisplay: ThinkingDisplayMode;
  /** Tool calls still being written, per conversation (`pendingToolCalls.ts`). */
  pendingToolCallsById: PendingToolCalls;
}

export const initialState: State = {
  messagesById: {},
  syncedIds: new Set(),
  streamingIds: new Set(),
  generatingIds: new Set(),
  pendingToolCallsById: new Map(),
  models: [],
  activeModel: null,
  backendReady: false,
  checkpointPendingIds: new Set(),
  checkpointStatsById: new Map(),
  backendStartRowIds: new Map(),
  sessionHydrated: false,
  tabs: [],
  history: [],
  archived: [],
  activeConversationId: '',
  clankerMode: false,
  remote: { transports: [], paired: false },
  activityView: 'full',
  thinkingDisplay: 'collapsed',
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
export function selectCheckpointStats(state: State): CheckpointStats | undefined {
  return state.checkpointStatsById.get(state.activeConversationId);
}

export type Action =
  | { type: 'TOKEN'; text: string; createdAt?: number; convId?: string }
  | { type: 'NOTICE'; message: string; convId?: string; preformatted?: boolean }
  | { type: 'REASONING_TOKEN'; text: string; createdAt?: number; convId?: string }
  | { type: 'GENERATION_STARTED'; convId?: string }
  | { type: 'DONE'; convId?: string; finishReason?: string | null }
  | {
      type: 'TOOL_CALL_PROGRESS';
      convId?: string;
      index: number;
      toolCallId?: string;
      toolName: string;
      target?: string;
      tokens: number;
    }
  | { type: 'ERROR'; message: string; convId?: string }
  | { type: 'READY'; convId?: string }
  | { type: 'BACKEND_STARTING'; message: string; convId?: string }
  | { type: 'BACKEND_DOWN'; message: string; convId?: string }
  | { type: 'MODELS'; models: ModelEntry[]; active: string | null }
  | {
      type: 'USER_SEND';
      text: string;
      createdAt?: number;
      convId?: string;
      /** Shown immediately from the bytes still in hand; the next sync replaces
       *  them with the host's stored references. */
      attachments?: MessageAttachment[];
      sender?: AgentSenderMetadata;
    }
  | { type: 'MID_TURN_TELL'; text: string; createdAt?: number; convId?: string }
  | { type: 'SET_MODEL'; name: string | null }
  | { type: 'CHECKPOINT_READY'; convId?: string; stats: CheckpointStats }
  | { type: 'CHECKPOINT_DISMISSED'; convId?: string }
  | {
      type: 'TOOL_ACTIVITY';
      toolName: string;
      toolCallId?: string;
      detail?: string;
      convId?: string;
    }
  | {
      type: 'TOOL_RESULT';
      toolName: string;
      toolCallId?: string;
      label: string;
      text: string;
      totalChars: number;
      filePath?: string;
      isError?: boolean;
      convId?: string;
    }
  | {
      type: 'FILE_DIFF';
      toolCallId?: string;
      filePath: string;
      hunks: DiffHunk[] | null;
      isNew: boolean;
      isDeleted: boolean;
      convId?: string;
    }
  | { type: 'CLANKER_CHANGED'; enabled: boolean }
  | { type: 'REMOTE_STATUS'; transports: string[]; paired: boolean }
  | { type: 'ACTIVITY_VIEW'; mode: ActivityViewMode }
  | { type: 'THINKING_DISPLAY'; mode: ThinkingDisplayMode }
  | {
      type: 'SESSION_SYNC';
      activeId: string;
      tabs: SessionTabMeta[];
      history: SessionHistoryMeta[];
      archived: SessionHistoryMeta[];
      messagesById: Record<string, PersistedRow[]>;
      attachmentsRoot?: string | undefined;
    };
