/** Tab row mirrored for host + webview (docs/multi-tab-chat-plan.md). */
export interface SessionTabMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  active_model?: string;
}

export interface SessionHistoryMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  active_model?: string;
}

/** Slash commands from the sidebar input (`/` menu); kept in sync with `webview-ui/src/slashCommands.ts`. */
export type ForgeSlashCommandId =
  | 'unloadModel'
  | 'restartBackend'
  | 'newChat'
  | 'clearChat'
  | 'review'
  | 'compact'
  | 'undo'
  | 'keep'
  | 'reloadWindow';

// ── Host → Webview ────────────────────────────────────────────────────────────

export interface TokenMsg          { type: 'token';              text: string }
export interface ReasoningTokenMsg { type: 'reasoningToken';     text: string }
export interface DoneMsg           { type: 'done';               finishReason: string | null }
export interface ErrorMsg          { type: 'error';              message: string }
export interface ReadyMsg          { type: 'ready' }
export interface BackendStartingMsg { type: 'backendStarting';   message: string }
export interface BackendDownMsg    { type: 'backendDown';        message: string }
export interface ModelsMsg         { type: 'models';             names: string[]; active: string | null }
export interface CheckpointReadyMsg   { type: 'checkpointReady' }
export interface CheckpointDismissedMsg { type: 'checkpointDismissed' }
/** @deprecated Prefer sessionSync — kept for compat with stale webviews. */
export interface NewChatMsg        { type: 'newChat' }

export interface ConfirmRequestMsg   { type: 'confirmRequest'; id: string; toolName: string; detail: string; isDangerous?: boolean }
export interface ToolActivityMsg     { type: 'toolActivity';   toolName: string; detail?: string }
export interface TokenBudgetMsg      { type: 'tokenBudget'; used: number; max: number }
export interface SetInputMsg         { type: 'setInput'; text: string }
/** @deprecated Replaced by sessionSync on load. */
export interface HistoryRestoreMsg   { type: 'historyRestore'; messages: Array<{ role: 'user' | 'assistant'; content: string }> }

/** Authoritative multi-tab state (tabs + transcripts). */
export interface SessionSyncMsg {
  type: 'sessionSync';
  activeId: string;
  tabs: SessionTabMeta[];
  history: SessionHistoryMeta[];
  messagesById: Record<string, Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string | undefined }>>;
}

export type HostToWebview =
  | TokenMsg
  | ReasoningTokenMsg
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
  | TokenBudgetMsg
  | SetInputMsg
  | HistoryRestoreMsg
  | SessionSyncMsg;

// ── Webview → Host ────────────────────────────────────────────────────────────

export interface AttachmentData {
  name: string;
  /** MIME type: 'image/png', 'image/jpeg', 'text/plain', etc. */
  mediaType: string;
  /** Base64-encoded for images; raw UTF-8 text for text files. */
  data: string;
}

export interface SendMsg           { type: 'send'; text: string; attachments?: AttachmentData[] }
export interface CancelMsg         { type: 'cancel' }
export interface SwitchModelMsg    { type: 'switchModel';      name: string | null }
export interface WebviewReadyMsg   { type: 'webviewReady' }
export interface UndoMsg           { type: 'undo' }
export interface KeepMsg           { type: 'keep' }
/** @deprecated Maps to newConversation on host. */
export interface NewChatRequestMsg { type: 'newChat' }
export interface NewConversationMsg { type: 'newConversation' }
export interface SwitchConversationMsg { type: 'switchConversation'; id: string }
export interface CloseConversationMsg { type: 'closeConversation'; id: string }
export interface RestoreConversationMsg { type: 'restoreConversation'; id: string }

// v0.2+ additions
export interface ConfirmResponseMsg { type: 'confirmResponse'; id: string; approved: boolean }
export interface RunSlashCommandMsg { type: 'runSlashCommand'; commandId: ForgeSlashCommandId }
export interface OpenFileMsg       { type: 'openFile'; path: string }

export type WebviewToHost =
  | SendMsg
  | CancelMsg
  | SwitchModelMsg
  | WebviewReadyMsg
  | UndoMsg
  | KeepMsg
  | NewChatRequestMsg
  | NewConversationMsg
  | SwitchConversationMsg
  | CloseConversationMsg
  | RestoreConversationMsg
  | ConfirmResponseMsg
  | OpenFileMsg
  | RunSlashCommandMsg;
