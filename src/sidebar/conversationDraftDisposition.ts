import * as vscode from 'vscode';

/** Keep explicit Close/ Delete from silently discarding webview-only composer state. */
export async function confirmDraftClose(
  title: string,
  draft: boolean | undefined,
): Promise<boolean> {
  if (draft === undefined) {
    await vscode.window.showInformationMessage(
      'Forge is still checking this chat for an unsent draft. Wait for the sidebar to finish loading, then close it again.',
    );
    return false;
  }
  if (!draft) return true;
  return (
    (await vscode.window.showWarningMessage(
      `Close "${title}" and discard its unsent draft and attachments?`,
      { modal: true },
      'Discard and Close',
    )) === 'Discard and Close'
  );
}

export async function confirmDraftDeletion(
  title: string,
  draft: boolean | undefined,
): Promise<boolean> {
  if (draft !== undefined) return true;
  await vscode.window.showInformationMessage(
    `Forge is still checking "${title}" for an unsent draft. Wait for the sidebar to finish loading, then delete it again.`,
  );
  return false;
}
