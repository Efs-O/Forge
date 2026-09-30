/**
 * Attachment access for the sidebar webview.
 *
 * Extracted from `SidebarProvider` (pure move — no behaviour change). These two
 * helpers are the only attachment surface that closes over just the store and
 * the current view, so they move cleanly; the rest of the provider's methods
 * close over the whole runtime and stay.
 */

import * as vscode from 'vscode';
import type { ChatAttachmentStore } from './ChatAttachmentStore';

/** The narrow slice the attachment helpers need: the store and the live view. */
export interface AttachmentAccess {
  store: ChatAttachmentStore | undefined;
  view: () => vscode.WebviewView | undefined;
}

/**
 * The webview URI root for stored attachments, or undefined when there is no
 * store or no live view. Used to build the thumbnail URLs in a session-sync
 * message.
 */
export function attachmentsRootUri(a: AttachmentAccess): string | undefined {
  if (!a.store || !a.view()) return undefined;
  return a.view()!.webview.asWebviewUri(vscode.Uri.file(a.store.rootPath)).toString();
}

/**
 * Opens a stored attachment in VS Code's own viewer — the image preview for
 * images, the editor for text. `resolve` refuses a path that escapes the store,
 * so a crafted transcript row cannot address arbitrary files.
 */
export async function openAttachment(a: AttachmentAccess, relativePath: string): Promise<void> {
  if (!a.store) throw new Error('attachments are not stored in this window');
  const target = a.store.resolve(relativePath);
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
}
