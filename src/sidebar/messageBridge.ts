import type { Mode } from '../llm/types';

// ── Host → Webview ────────────────────────────────────────────────────────────

export interface TokenMsg          { type: 'token';              text: string }
export interface DoneMsg           { type: 'done';               finishReason: string | null }
export interface ErrorMsg          { type: 'error';              message: string }
export interface ReadyMsg          { type: 'ready' }
export interface BackendDownMsg    { type: 'backendDown';        message: string }
export interface ModelsMsg         { type: 'models';             names: string[]; active: string }
export interface CheckpointReadyMsg   { type: 'checkpointReady' }
export interface CheckpointDismissedMsg { type: 'checkpointDismissed' }
export interface NewChatMsg        { type: 'newChat' }

// v0.2+ additions
export interface SelectionContentMsg { type: 'selectionContent'; text: string }
export interface ConfirmRequestMsg   { type: 'confirmRequest'; id: string; toolName: string; detail: string }
export interface TokenBudgetMsg      { type: 'tokenBudget'; used: number; max: number }
export interface HistoryRestoreMsg   { type: 'historyRestore'; messages: Array<{ role: 'user' | 'assistant'; content: string }> }

export type HostToWebview =
  | TokenMsg
  | DoneMsg
  | ErrorMsg
  | ReadyMsg
  | BackendDownMsg
  | ModelsMsg
  | CheckpointReadyMsg
  | CheckpointDismissedMsg
  | NewChatMsg
  | SelectionContentMsg
  | ConfirmRequestMsg
  | TokenBudgetMsg
  | HistoryRestoreMsg;

// ── Webview → Host ────────────────────────────────────────────────────────────

export interface SendMsg           { type: 'send';             text: string; mode: Mode }
export interface CancelMsg         { type: 'cancel' }
export interface SwitchModelMsg    { type: 'switchModel';      name: string }
export interface WebviewReadyMsg   { type: 'webviewReady' }
export interface UndoMsg           { type: 'undo' }
export interface KeepMsg           { type: 'keep' }
export interface NewChatRequestMsg { type: 'newChat' }

// v0.2+ additions
export interface ConfirmResponseMsg { type: 'confirmResponse'; id: string; approved: boolean }
export interface SendSelectionMsg   { type: 'sendSelection' }
export interface SetInputMsg        { type: 'setInput'; text: string }
export interface InsertAtCursorMsg  { type: 'insertAtCursor'; text: string }
export interface ReplaceSelectionMsg { type: 'replaceSelection'; text: string }

export type WebviewToHost =
  | SendMsg
  | CancelMsg
  | SwitchModelMsg
  | WebviewReadyMsg
  | UndoMsg
  | KeepMsg
  | NewChatRequestMsg
  | ConfirmResponseMsg
  | SendSelectionMsg
  | SetInputMsg
  | InsertAtCursorMsg
  | ReplaceSelectionMsg;
