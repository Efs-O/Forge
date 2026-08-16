/**
 * Shared behaviour behind the Forge commands: backend state transitions, and
 * the prefill/run/scratch paths that turn editor context into a prompt.
 *
 * Split out of `nativeCommands.ts` — the registrations name the commands, this
 * is what they do.
 */

import * as vscode from 'vscode';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import type { NativeCommandDeps } from './commandDeps';
import {
  activeFileBlock,
  activeSelectionBlock,
  diagnosticSnippet,
  formatContextBlocks,
  nearestDiagnostic,
  relativePath,
} from './editorContext';
import { openMarkdownScratch } from './scratchDocuments';

export async function runBackendAction(
  deps: NativeCommandDeps,
  state: 'starting' | 'stopping',
  action: () => Promise<void>,
  success: string,
): Promise<void> {
  const modelName = deps.getConfig().active_model;
  if (state === 'starting') deps.statusBar.setStarting(modelName);
  if (state === 'stopping') deps.statusBar.setStopped(modelName);
  try {
    await action();
    if (state === 'stopping') deps.statusBar.setStopped(modelName);
    else deps.statusBar.setReady(modelName);
    void vscode.window.showInformationMessage(success);
  } catch (err) {
    const message = (err as Error).message;
    deps.statusBar.setError(message);
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  }
}

export function prefillSelection(sidebar: SidebarProvider, instruction: string): void {
  const block = activeSelectionBlock();
  if (!block) {
    void vscode.window.showInformationMessage('Forge: select code first');
    return;
  }
  sidebar.prefillInput(`${instruction}\n\n${formatContextBlocks([block])}`);
}

export function prefillBlocks(
  sidebar: SidebarProvider,
  instruction: string,
  block: ReturnType<typeof activeFileBlock>,
): void {
  if (!block) {
    void vscode.window.showInformationMessage('Forge: no active editor context found');
    return;
  }
  sidebar.prefillInput(`${instruction}\n\n${formatContextBlocks([block])}`);
}

export function prefillManyBlocks(
  sidebar: SidebarProvider,
  instruction: string,
  blocks: NonNullable<ReturnType<typeof activeFileBlock>>[],
): void {
  if (blocks.length === 0) {
    void vscode.window.showInformationMessage('Forge: no files selected for context');
    return;
  }
  if (blocks.some((block) => block.truncated)) {
    void vscode.window.showWarningMessage(
      'Forge: some context was truncated before adding it to the prompt',
    );
  }
  sidebar.prefillInput(`${instruction}\n\n${formatContextBlocks(blocks)}`);
}

export async function prefillDiagnostic(
  sidebar: SidebarProvider,
  instruction: string,
  uri?: vscode.Uri,
  diagnostic?: vscode.Diagnostic,
): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    void vscode.window.showInformationMessage('Forge: no active diagnostic target');
    return;
  }
  const targetDiagnostic = diagnostic ?? nearestDiagnostic(targetUri);
  if (!targetDiagnostic) {
    void vscode.window.showInformationMessage('Forge: no diagnostics found');
    return;
  }
  const document = await vscode.workspace.openTextDocument(targetUri);
  const source = targetDiagnostic.source ? `\nSource: ${targetDiagnostic.source}` : '';
  const code =
    targetDiagnostic.code === undefined ? '' : `\nCode: ${String(targetDiagnostic.code)}`;
  sidebar.prefillInput(
    `${instruction}\n\nFile: ${relativePath(targetUri)}\nDiagnostic: ${targetDiagnostic.message}${source}${code}\nRange: ${targetDiagnostic.range.start.line + 1}:${targetDiagnostic.range.start.character + 1}-${targetDiagnostic.range.end.line + 1}:${targetDiagnostic.range.end.character + 1}\n\nRelevant code:\n\`\`\`${document.languageId}\n${diagnosticSnippet(document, targetDiagnostic)}\n\`\`\``,
  );
}

export async function draftScratch(deps: NativeCommandDeps, instruction: string): Promise<void> {
  const selection = activeSelectionBlock();
  const block = selection ?? activeFileBlock();
  if (!block) {
    void vscode.window.showInformationMessage('Forge: no editor context found for scratch output');
    return;
  }
  deps.statusBar.setGenerating(deps.getConfig().active_model);
  try {
    const content = await deps.sidebar.runPromptToMarkdown(
      `${instruction}\n\n${formatContextBlocks([block])}`,
    );
    await openMarkdownScratch(content.trim() ? content : '# Forge\n\nNo content returned.');
  } catch (err) {
    const message = (err as Error).message;
    deps.statusBar.setError(message);
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  } finally {
    if (deps.backend.isAnyReady()) deps.statusBar.setReady(deps.getConfig().active_model);
  }
}

export async function runSelectionPrompt(
  deps: NativeCommandDeps,
  instruction: string,
): Promise<void> {
  const block = activeSelectionBlock();
  if (!block) {
    void vscode.window.showInformationMessage('Forge: select code first');
    return;
  }
  deps.statusBar.setGenerating(deps.getConfig().active_model);
  try {
    await deps.sidebar.submitPrompt(`${instruction}\n\n${formatContextBlocks([block])}`);
  } catch (err) {
    const message = (err as Error).message;
    deps.statusBar.setError(message);
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  }
}

export async function runDiagnosticPrompt(
  deps: NativeCommandDeps,
  instruction: string,
  uri?: vscode.Uri,
  diagnostic?: vscode.Diagnostic,
): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    void vscode.window.showInformationMessage('Forge: no active diagnostic target');
    return;
  }
  const targetDiagnostic = diagnostic ?? nearestDiagnostic(targetUri);
  if (!targetDiagnostic) {
    void vscode.window.showInformationMessage('Forge: no diagnostics found');
    return;
  }
  const document = await vscode.workspace.openTextDocument(targetUri);
  const source = targetDiagnostic.source ? `\nSource: ${targetDiagnostic.source}` : '';
  const code =
    targetDiagnostic.code === undefined ? '' : `\nCode: ${String(targetDiagnostic.code)}`;
  deps.statusBar.setGenerating(deps.getConfig().active_model);
  try {
    await deps.sidebar.submitPrompt(
      `${instruction}\n\nFile: ${relativePath(targetUri)}\nDiagnostic: ${targetDiagnostic.message}${source}${code}\nRange: ${targetDiagnostic.range.start.line + 1}:${targetDiagnostic.range.start.character + 1}-${targetDiagnostic.range.end.line + 1}:${targetDiagnostic.range.end.character + 1}\n\nRelevant code:\n\`\`\`${document.languageId}\n${diagnosticSnippet(document, targetDiagnostic)}\n\`\`\``,
    );
  } catch (err) {
    const message = (err as Error).message;
    deps.statusBar.setError(message);
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  }
}
