/** Tab row mirrored for host + webview. */
export interface SessionTabMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  active_model?: string;
  /** True while an agent turn is streaming in this conversation. */
  streaming?: boolean;
  /** Accumulated active-agent time for the tab badge. */
  active_time_ms?: number;
}

export interface SessionHistoryMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  active_model?: string;
  /** Accumulated active-agent time for the history badge. */
  active_time_ms?: number;
}

/** Slash commands from the sidebar input (`/` menu); kept in sync with `webview-ui/src/slashCommands.ts`. */
export type ForgeSlashCommandId =
  | 'unloadModel'
  | 'restartBackend'
  | 'reindex'
  | 'newChat'
  | 'clearChat'
  | 'review'
  | 'compact'
  | 'undo'
  | 'keep'
  | 'reloadWindow'
  | 'initForge'
  | 'clanker';

// ── Host → Webview ────────────────────────────────────────────────────────────

export interface TokenMsg {
  type: 'token';
  text: string;
  conversationId?: string;
}
/** A non-model status row displayed in the conversation. */
export interface NoticeMsg {
  type: 'notice';
  message: string;
  conversationId?: string;
}
export interface ReasoningTokenMsg {
  type: 'reasoningToken';
  text: string;
  conversationId?: string;
}
export interface GenerationStartedMsg {
  type: 'generationStarted';
  conversationId?: string;
}
export interface DoneMsg {
  type: 'done';
  finishReason: string | null;
  conversationId?: string;
}
export interface ErrorMsg {
  type: 'error';
  message: string;
  conversationId?: string;
}
export interface ReadyMsg {
  type: 'ready';
  conversationId?: string;
}
export interface BackendStartingMsg {
  type: 'backendStarting';
  message: string;
  conversationId?: string;
}
export interface BackendDownMsg {
  type: 'backendDown';
  message: string;
  conversationId?: string;
}
export interface ModelEntry {
  name: string;
  provider: string;
  /** Presentation-only category calculated by the extension host. */
  group?: string;
}
export interface ModelsMsg {
  type: 'models';
  models: ModelEntry[];
  active: string | null;
}
export interface CheckpointReadyMsg {
  type: 'checkpointReady';
  conversationId?: string;
}
export interface CheckpointDismissedMsg {
  type: 'checkpointDismissed';
  conversationId?: string;
}
/** @deprecated Prefer sessionSync — kept for compat with stale webviews. */
export interface NewChatMsg {
  type: 'newChat';
}

export interface ConfirmRequestMsg {
  type: 'confirmRequest';
  id: string;
  toolName: string;
  detail: string;
  isDangerous?: boolean;
  conversationId?: string;
}
/**
 * A finished tool call. Replaces the old practice of injecting a flattened
 * 600-char preview into the assistant token stream as fake markdown: that could
 * not be collapsed (it was not a message) and destroyed the newlines of any
 * long result, such as a delegated CLI agent's report.
 */
export interface ToolResultMsg {
  type: 'toolResult';
  toolName: string;
  /** Correlates a result with its activity row when a model issued parallel calls. */
  toolCallId?: string;
  /** One-line row label — a path for read-only tools, else a short summary. */
  label: string;
  /** Full result text, capped for display and with newlines intact. */
  text: string;
  /** Size of the untruncated result, so the row can say what was cut. */
  totalChars: number;
  /** Absolute path to offer as an "open" link, when the tool touched one file. */
  filePath?: string;
  isError?: boolean;
  conversationId?: string;
}
export interface ToolActivityMsg {
  type: 'toolActivity';
  toolName: string;
  /** Native tool-call id, when this activity represents one model tool call. */
  toolCallId?: string;
  detail?: string;
  conversationId?: string;
}
export interface WorkerStatusMsg {
  type: 'workerStatus';
  runId: string;
  stage:
    | 'run-started'
    | 'worker-started'
    | 'worker-finished'
    | 'review-started'
    | 'worker-progress';
  workerId?: string;
  model?: string;
  status?: string;
  executionMode?: 'parallel' | 'serial' | 'best-effort';
  elapsedMs: number;
  changedPaths?: string[];
  conversationId?: string;
  /** 'worker-progress' only — a concise status/text line from a `provider: cli`
   *  external agent, relayed to the sidebar worker status surface as it streams. */
  detail?: string;
}
export interface TokenBudgetMsg {
  type: 'tokenBudget';
  used: number;
  max: number;
}

export type DiffLineKind = 'context' | 'added' | 'removed';
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface ClankerChangedMsg {
  type: 'clankerChanged';
  enabled: boolean;
}

export interface FileDiffMsg {
  type: 'fileDiff';
  filePath: string;
  hunks: DiffHunk[] | null;
  isNew: boolean;
  isDeleted: boolean;
  conversationId?: string;
}

export interface SetInputMsg {
  type: 'setInput';
  text: string;
}
/** @deprecated Replaced by sessionSync on load. */
export interface HistoryRestoreMsg {
  type: 'historyRestore';
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}
export interface ThreadStreamStateChangedMsg {
  type: 'thread-stream-state-changed';
}
export interface ThreadReadStateChangedMsg {
  type: 'thread-read-state-changed';
}

/** Authoritative multi-tab state (tabs + transcripts). */
export interface SessionSyncMsg {
  type: 'sessionSync';
  activeId: string;
  tabs: SessionTabMeta[];
  history: SessionHistoryMeta[];
  messagesById: Record<
    string,
    Array<
      | { role: 'user' | 'assistant'; content: string; reasoning?: string | undefined }
      | {
          role: 'tool';
          content: string;
          toolName: string;
          toolResult: string;
          toolResultTotal: number;
          toolIsError?: boolean | undefined;
        }
      | {
          role: 'diff';
          content: string;
          diffHunks: DiffHunk[] | null;
          diffIsNew: boolean;
          diffIsDeleted: boolean;
        }
    >
  >;
}

export type HostToWebview =
  | TokenMsg
  | NoticeMsg
  | ReasoningTokenMsg
  | GenerationStartedMsg
  | DoneMsg
  | ErrorMsg
  | ReadyMsg
  | BackendStartingMsg
  | BackendDownMsg
  | ModelsMsg
  | CheckpointReadyMsg
  | CheckpointDismissedMsg
  | NewChatMsg
  | ConfirmRequestMsg
  | ToolActivityMsg
  | ToolResultMsg
  | WorkerStatusMsg
  | TokenBudgetMsg
  | SetInputMsg
  | HistoryRestoreMsg
  | ThreadStreamStateChangedMsg
  | ThreadReadStateChangedMsg
  | SessionSyncMsg
  | FileDiffMsg
  | ClankerChangedMsg;

// ── Webview → Host ────────────────────────────────────────────────────────────

export interface AttachmentData {
  name: string;
  /** MIME type: 'image/png', 'image/jpeg', 'text/plain', etc. */
  mediaType: string;
  /** Base64-encoded for images; raw UTF-8 text for text files. */
  data: string;
}

export interface SendMsg {
  type: 'send';
  text: string;
  attachments?: AttachmentData[];
  /** Set by the standby-prompt queue so it stays with the conversation that queued it. */
  conversationId?: string;
}
export interface SteerMsg {
  type: 'steer';
  text: string;
  attachments?: AttachmentData[];
  conversationId: string;
}
export interface CancelMsg {
  type: 'cancel';
}
export interface SwitchModelMsg {
  type: 'switchModel';
  name: string | null;
}
export interface WebviewReadyMsg {
  type: 'webviewReady';
}
export interface UndoMsg {
  type: 'undo';
}
export interface KeepMsg {
  type: 'keep';
}
/** Open the pending turn's changes in the native diff editor, without dismissing. */
export interface ReviewCheckpointMsg {
  type: 'reviewCheckpoint';
}
/** @deprecated Maps to newConversation on host. */
export interface NewChatRequestMsg {
  type: 'newChat';
}
export interface NewConversationMsg {
  type: 'newConversation';
}
export interface SwitchConversationMsg {
  type: 'switchConversation';
  id: string;
}
export interface CloseConversationMsg {
  type: 'closeConversation';
  id: string;
}
export interface RestoreConversationMsg {
  type: 'restoreConversation';
  id: string;
}

// v0.2+ additions
export interface ConfirmResponseMsg {
  type: 'confirmResponse';
  id: string;
  approved: boolean;
}
export interface RunSlashCommandMsg {
  type: 'runSlashCommand';
  commandId: ForgeSlashCommandId;
}
export interface OpenFileMsg {
  type: 'openFile';
  path: string;
  /** 1-based line to reveal, from a `path:42` reference in the transcript. */
  line?: number;
  /** Ctrl/Cmd-click: open in the editor group beside the active one. */
  beside?: boolean;
}

export type WebviewDiagnosticKind =
  | 'mount'
  | 'unmount'
  | 'heartbeat'
  | 'error'
  | 'unhandledrejection'
  | 'react-error';

export interface WebviewDiagnosticBreadcrumb {
  timestamp: number;
  event: string;
  conversationId?: string;
  detail?: string;
}

export interface WebviewDiagnosticSummary {
  uptimeMs: number;
  hostMessages: number;
  messageTypes: Record<string, number>;
  renders: number;
  inputChanges: number;
  activeConversationId: string;
  displayedMessages: number;
  queuedPrompts: number;
  streaming: boolean;
  prefillPending: boolean;
}

/** Bounded, content-free diagnostics from the isolated React webview. */
export interface WebviewDiagnosticMsg {
  type: 'webviewDiagnostic';
  instanceId: string;
  kind: WebviewDiagnosticKind;
  timestamp: number;
  summary: WebviewDiagnosticSummary;
  message?: string;
  stack?: string;
  componentStack?: string;
  recent?: WebviewDiagnosticBreadcrumb[];
}

export type WebviewToHost =
  | SendMsg
  | SteerMsg
  | CancelMsg
  | SwitchModelMsg
  | WebviewReadyMsg
  | UndoMsg
  | KeepMsg
  | ReviewCheckpointMsg
  | NewChatRequestMsg
  | NewConversationMsg
  | SwitchConversationMsg
  | CloseConversationMsg
  | RestoreConversationMsg
  | ConfirmResponseMsg
  | OpenFileMsg
  | RunSlashCommandMsg
  | WebviewDiagnosticMsg;
