import * as vscode from 'vscode';

export async function openMarkdownScratch(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
