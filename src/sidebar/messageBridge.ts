import type { QuestionGroup } from '../util/questionAnswers';
import type { ChatAttachmentRef } from '../llm/types';

export type { ChatAttachmentRef };

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
  | 'rename'
  | 'context'
  | 'config'
  | 'logs'
  | 'clearChat'
  | 'review'
  | 'compact'
  | 'undo'
  | 'keep'
  | 'reloadWindow'
  | 'initForge'
  | 'clanker'
  | 'system';

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
  /** Render the message verbatim in a monospace block instead of as a one-line
   *  status row. For reports whose columns carry meaning (`/system`). */
  preformatted?: boolean;
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
/**
 * A prompt this webview did NOT type: one sent from a paired chat, or by a VS
 * Code command.
 *
 * The user bubble is normally drawn by the webview from its own USER_SEND, so a
 * remote prompt used to start a turn with nothing above it. `sessionSync` could
 * not repair that either -- it deliberately keeps the local transcript for a
 * conversation that is streaming, which is exactly the state a remote turn is
 * in from the moment it is admitted.
 */
export interface UserPromptMsg {
  type: 'userPrompt';
  text: string;
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
/**
 * Local backend state for the picker's readiness dot.
 *
 * - `ready`   — resident and serving; the next send starts immediately.
 * - `loading` — resident but still spawning.
 * - `cold`    — not resident; the next send pays a full model load.
 */
export type ModelResidency = 'ready' | 'loading' | 'cold';

export interface ModelEntry {
  name: string;
  provider: string;
  /** Presentation-only category calculated by the extension host. */
  group?: string;
  /**
   * Absent when residency is not a meaningful concept for this model — every
   * remote route, including Ollama *cloud* models, which reach the daemon on
   * localhost but hold no VRAM here. Rendering those as `cold` would advertise
   * a load cost that does not exist, so they get no dot at all.
   */
  residency?: ModelResidency;
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
 * An agent question raised by `ask_user`.
 *
 * Deliberately shaped like ConfirmRequestMsg: both are modal, both can be
 * settled by a surface other than this webview, and both therefore need a
 * resolved counterpart. The difference is that a question can want free text
 * back, which an approval's two buttons cannot carry.
 */
export interface QuestionRequestMsg {
  type: 'question';
  id: string;
  prompt: string;
  placeholder?: string;
  options?: readonly string[];
  /** Sub-questions with their own choice lists; `options` is ignored with these. */
  questions?: readonly QuestionGroup[];
  conversationId?: string;
}
/** A question something else settled — a paired chat, or a cancelled turn. */
export interface QuestionResolvedMsg {
  type: 'questionResolved';
  id: string;
}
/**
 * A pending approval that something OTHER than this webview settled — a remote
 * transport button, or a cancelled turn. Without it the sidebar keeps showing
 * live-looking Approve/Deny buttons for an approval that is already resolved.
 */
export interface ConfirmResolvedMsg {
  type: 'confirmResolved';
  id: string;
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

/**
 * Whether anything can reach this window from outside it. Sent on the
 * `webviewReady` handshake and again on every transport or pairing change, so a
 * reloaded webview never has to ask.
 */
export interface RemoteStatusMsg {
  type: 'remoteStatus';
  /** Running transports, sorted; empty when remote control is off. */
  transports: string[];
  /** True when at least one running transport has a paired owner. */
  paired: boolean;
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
      | {
          role: 'user' | 'assistant';
          content: string;
          reasoning?: string | undefined;
          reasoningMs?: number | undefined;
          attachments?: ChatAttachmentRef[] | undefined;
        }
      | {
          role: 'tool';
          content: string;
          toolName: string;
          toolResult: string;
          toolResultTotal: number;
          toolIsError?: boolean | undefined;
          toolMs?: number | undefined;
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
  /**
   * Webview-URI prefix for the chat attachment store, so a transcript row's
   * `relativePath` resolves to something the webview may load. Absent when the
   * host has no attachment store — rows then render as plain file chips.
   */
  attachmentsRoot?: string;
}

/**
 * Which folder this window's tools actually resolve against.
 *
 * Every `path`, `cwd`, and glob resolves against `workspaceFolders[0]`, which
 * is not always the folder the user believes they opened — a multi-root
 * workspace listing another project first silently aims the whole agent at it.
 * The header shows this so the answer is visible before a turn runs, not after
 * the model reports a surprising root.
 */
export interface WorkspaceInfoMsg {
  type: 'workspaceInfo';
  /** Basename of `workspaceFolders[0]`, or '' when no folder is open. */
  name: string;
  /** Absolute path of `workspaceFolders[0]`, for the hover title. */
  path: string;
  /** Count of additional roots; > 0 means the folder order is load-bearing. */
  extraRoots: number;
  /** True once the roots changed since activation — the captured root is stale. */
  stale: boolean;
  /** Webview URI of `path`, for thumbnails of workspace images (generate_image). */
  rootUri?: string;
}

export type HostToWebview =
  | TokenMsg
  | NoticeMsg
  | ReasoningTokenMsg
  | GenerationStartedMsg
  | UserPromptMsg
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
  | ConfirmResolvedMsg
  | QuestionRequestMsg
  | QuestionResolvedMsg
  | ToolActivityMsg
  | ToolResultMsg
  | TokenBudgetMsg
  | SetInputMsg
  | HistoryRestoreMsg
  | ThreadStreamStateChangedMsg
  | ThreadReadStateChangedMsg
  | SessionSyncMsg
  | FileDiffMsg
  | ClankerChangedMsg
  | RemoteStatusMsg
  | WorkspaceInfoMsg;

// ── Webview → Host ──────────────────────────────────────────────────────────

// Re-exported rather than moved out of reach: the bridge stays the single
// import for every message shape, wherever the declaration happens to live.
export type {
  WebviewDiagnosticKind,
  WebviewDiagnosticBreadcrumb,
  WebviewDiagnosticSummary,
  WebviewDiagnosticMsg,
} from './diagnosticMessages';

import type { WebviewDiagnosticMsg } from './diagnosticMessages';

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
export type {
  NewChatRequestMsg,
  NewConversationMsg,
  SwitchConversationMsg,
  CloseConversationMsg,
  RestoreConversationMsg,
  DeleteConversationMsg,
  RenameConversationMsg,
} from './conversationMessages';

import type {
  NewChatRequestMsg,
  NewConversationMsg,
  SwitchConversationMsg,
  CloseConversationMsg,
  RestoreConversationMsg,
  DeleteConversationMsg,
  RenameConversationMsg,
} from './conversationMessages';

// v0.2+ additions
export interface ConfirmResponseMsg {
  type: 'confirmResponse';
  id: string;
  approved: boolean;
}
/** The sidebar's answer to a `question`. `text: undefined` means dismissed. */
export interface QuestionResponseMsg {
  type: 'questionResponse';
  id: string;
  text?: string;
}
export interface RunSlashCommandMsg {
  type: 'runSlashCommand';
  commandId: ForgeSlashCommandId;
}

export type { OpenFileMsg, OpenAttachmentMsg } from './openMessages';

import type { OpenFileMsg, OpenAttachmentMsg } from './openMessages';

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
  | DeleteConversationMsg
  | RenameConversationMsg
  | ConfirmResponseMsg
  | QuestionResponseMsg
  | OpenFileMsg
  | OpenAttachmentMsg
  | RunSlashCommandMsg
  | WebviewDiagnosticMsg;
