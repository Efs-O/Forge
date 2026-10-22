import type { QuestionSpec, StructuredAnswer } from '../util/questionAnswers';
import type { ChatAttachmentRef } from '../llm/types';
import type { AgentLinks, AgentSenderMetadata } from '../agentLinks/chatAgentLinks';
import type { ActivityViewMode, ThinkingDisplayMode } from './activityViewSetting';
import type { DisplayPersistMessage } from './sessionTypes';
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
  agentLinks?: AgentLinks;
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
  | 'unloadAll'
  | 'restartBackend'
  | 'reindex'
  | 'newChat'
  | 'rename'
  | 'checkin'
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
  | 'system'
  | 'linkAgent'
  | 'unlinkAgent';

// ── Host → Webview ────────────────────────────────────────────────────────────
interface TokenMsg {
  type: 'token';
  text: string;
  createdAt?: number;
  conversationId?: string;
}
/** A non-model status row displayed in the conversation. */
interface NoticeMsg {
  type: 'notice';
  message: string;
  conversationId?: string;
  /** Render the message verbatim in a monospace block instead of as a one-line
   *  status row. For reports whose columns carry meaning (`/system`). */
  preformatted?: boolean;
  /** `warning` is sent to remote chats as a new message (a phone push), not an edit. */
  severity?: 'info' | 'warning';
}
interface ReasoningTokenMsg {
  type: 'reasoningToken';
  text: string;
  createdAt?: number;
  conversationId?: string;
}
interface GenerationStartedMsg {
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
interface UserPromptMsg {
  type: 'userPrompt';
  text: string;
  createdAt?: number;
  conversationId?: string;
  /** A tell the running turn just took in: shown inline, it opens no turn. */
  midTurn?: boolean;
  /** Files sent with a prompt from outside the webview (a paired chat), for its bubble. */
  attachments?: AttachmentData[];
  sender?: AgentSenderMetadata;
}
interface DoneMsg {
  type: 'done';
  finishReason: string | null;
  conversationId?: string;
}
interface ErrorMsg {
  type: 'error';
  message: string;
  conversationId?: string;
}
interface ReadyMsg {
  type: 'ready';
  conversationId?: string;
}
interface BackendStartingMsg {
  type: 'backendStarting';
  message: string;
  conversationId?: string;
}
interface BackendDownMsg {
  type: 'backendDown';
  message: string;
  conversationId?: string;
}
export type { ModelResidency, ModelEntry, ModelsMsg } from './modelMessages';
import type { ModelsMsg } from './modelMessages';
export interface CheckpointReadyMsg {
  type: 'checkpointReady';
  conversationId?: string;
  /** Net change of the pending checkpoint (`checkpointStats.ts`). */
  stats: CheckpointStats;
}
interface CheckpointDismissedMsg {
  type: 'checkpointDismissed';
  conversationId?: string;
}
/** @deprecated Prefer sessionSync — kept for compat with stale webviews. */
interface NewChatMsg {
  type: 'newChat';
}

interface ConfirmRequestMsg {
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
interface QuestionRequestMsg {
  type: 'question';
  id: string;
  prompt: string;
  placeholder?: string;
  specs: readonly QuestionSpec[];
  conversationId?: string;
}
/** A question something else settled — a paired chat, or a cancelled turn. */
interface QuestionResolvedMsg {
  type: 'questionResolved';
  id: string;
}
/**
 * A pending approval that something OTHER than this webview settled — a remote
 * transport button, or a cancelled turn. Without it the sidebar keeps showing
 * live-looking Approve/Deny buttons for an approval that is already resolved.
 */
interface ConfirmResolvedMsg {
  type: 'confirmResolved';
  id: string;
}
/**
 * A finished tool call. Replaces the old practice of injecting a flattened
 * 600-char preview into the assistant token stream as fake markdown: that could
 * not be collapsed (it was not a message) and destroyed the newlines of any
 * long result, such as a delegated CLI agent's report.
 */
interface ToolResultMsg {
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
interface ToolActivityMsg {
  type: 'toolActivity';
  toolName: string;
  /** Native tool-call id, when this activity represents one model tool call. */
  toolCallId?: string;
  detail?: string;
  conversationId?: string;
}
export interface ToolCallProgressMsg {
  type: 'toolCallProgress';
  conversationId?: string;
  index: number;
  toolCallId?: string;
  toolName: string;
  target?: string;
  tokens: number;
}
interface TokenBudgetMsg {
  type: 'tokenBudget';
  used: number;
  max: number;
  compactAt?: number;
}

export type {
  CheckpointStats,
  DiffLineKind,
  DiffLine,
  DiffHunk,
  DiffStats,
  FileDiffMsg,
} from './diffMessages';
import type { CheckpointStats, FileDiffMsg } from './diffMessages';

interface ClankerChangedMsg {
  type: 'clankerChanged';
  enabled: boolean;
}

/** External reach, sent on handshake and transport or pairing changes. */
interface RemoteStatusMsg {
  type: 'remoteStatus';
  /** Running transports, sorted; empty when remote control is off. */
  transports: string[];
  /** True when at least one running transport has a paired owner. */
  paired: boolean;
}

type ActivityViewMsg =
  | { type: 'activityView'; mode: ActivityViewMode }
  | { type: 'thinkingDisplay'; mode: ThinkingDisplayMode };
type SetInputMsg = { type: 'setInput'; text: string; conversationId?: string };
/** @deprecated Replaced by sessionSync on load. */
interface HistoryRestoreMsg {
  type: 'historyRestore';
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}
interface ThreadStreamStateChangedMsg {
  type: 'thread-stream-state-changed';
}
interface ThreadReadStateChangedMsg {
  type: 'thread-read-state-changed';
}

/** A divider row marking one compaction; display only, never sent to the model. */
export interface CompactionDividerMessage {
  role: 'compaction';
  content: 'Context compacted';
  generation: number;
  source?: 'auto' | 'manual';
}

/** Authoritative multi-tab state (tabs + transcripts). */
export interface SessionSyncMsg {
  type: 'sessionSync';
  activeId: string;
  tabs: SessionTabMeta[];
  history: SessionHistoryMeta[];
  archived: SessionHistoryMeta[];
  waitingIds: string[];
  messagesById: Record<string, Array<DisplayPersistMessage | CompactionDividerMessage>>;
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
interface WorkspaceInfoMsg {
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
  screenshotsUri?: string; // Webview URI of Forge's screenshot directory.
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
  | ToolCallProgressMsg
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
  | ActivityViewMsg
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

interface SendMsg {
  type: 'send';
  text: string;
  createdAt?: number;
  attachments?: AttachmentData[];
  /** Set by the standby-prompt queue so it stays with the conversation that queued it. */
  conversationId?: string;
  /** Present on a mid-turn tell: the id `cancelTell` withdraws it by. */
  tellId?: string;
}
export type { CancelTellMsg, SendQueuedNowMsg } from './tellMessages';
import type { CancelTellMsg, SendQueuedNowMsg } from './tellMessages';
interface CancelMsg {
  type: 'cancel';
}
interface SwitchModelMsg {
  type: 'switchModel';
  name: string | null;
}
interface WebviewReadyMsg {
  type: 'webviewReady';
}
interface QueuedConversationIdsMsg {
  type: 'queuedConversationIds';
  ids: string[];
}
interface UndoMsg {
  type: 'undo';
}
interface KeepMsg {
  type: 'keep';
}
/** Open the pending turn's changes in the native diff editor, without dismissing. */
interface ReviewCheckpointMsg {
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
interface ConfirmResponseMsg {
  type: 'confirmResponse';
  id: string;
  approved: boolean;
}
/** The sidebar's answer or explicit skip for a pending question. */
type QuestionResponseMsg =
  | {
      type: 'questionResponse';
      id: string;
      kind: 'answer';
      answer: StructuredAnswer;
    }
  | {
      type: 'questionResponse';
      id: string;
      kind: 'skip';
    };
interface RunSlashCommandMsg {
  type: 'runSlashCommand';
  commandId: ForgeSlashCommandId;
  agentKind?: string;
  sessionId?: string;
}

export type { OpenFileMsg, OpenAttachmentMsg } from './openMessages';

import type { OpenFileMsg, OpenAttachmentMsg } from './openMessages';

export type WebviewToHost =
  | SendMsg
  | CancelMsg
  | CancelTellMsg
  | SendQueuedNowMsg
  | SwitchModelMsg
  | WebviewReadyMsg
  | QueuedConversationIdsMsg
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
