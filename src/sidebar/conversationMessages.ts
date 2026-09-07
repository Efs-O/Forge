/**
 * Webview → host messages that address a conversation by id.
 *
 * Declared here rather than in `messageBridge` for the reason its own header
 * gives: the bridge stays the single import for every message shape, but the
 * shapes themselves may live wherever they group cleanly. These six are one
 * group — tab lifecycle — and none of them carries anything but an id.
 */

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
export interface DeleteConversationMsg {
  type: 'deleteConversation';
  id: string;
}
/** Rename any conversation by id — an open tab or one archived in history. */
export interface RenameConversationMsg {
  type: 'renameConversation';
  id: string;
  title: string;
}
