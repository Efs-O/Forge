import { vscode } from './vscode';

export function reportDraftBearingConversationIds(ids: string[]): void {
  vscode.postMessage({ type: 'draftBearingConversationIds', ids });
}

export function setConversationKeepOpen(id: string, keepOpen: boolean): void {
  vscode.postMessage({ type: 'setConversationKeepOpen', id, keepOpen });
}
