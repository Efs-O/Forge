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

export type HostToWebview =
  | TokenMsg
  | DoneMsg
  | ErrorMsg
  | ReadyMsg
  | BackendDownMsg
  | ModelsMsg
  | CheckpointReadyMsg
  | CheckpointDismissedMsg
  | NewChatMsg;

// ── Webview → Host ────────────────────────────────────────────────────────────

export interface SendMsg        { type: 'send';        text: string; mode: Mode }
export interface CancelMsg      { type: 'cancel' }
export interface SwitchModelMsg { type: 'switchModel'; name: string }
export interface WebviewReadyMsg { type: 'webviewReady' }
export interface UndoMsg        { type: 'undo' }
export interface KeepMsg        { type: 'keep' }
export interface NewChatRequestMsg { type: 'newChat' }

export type WebviewToHost =
  | SendMsg
  | CancelMsg
  | SwitchModelMsg
  | WebviewReadyMsg
  | UndoMsg
  | KeepMsg
  | NewChatRequestMsg;
