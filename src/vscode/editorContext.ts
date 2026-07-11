import * as path from 'path';
import * as vscode from 'vscode';

const MAX_FILES = 8;
const MAX_CHARS_PER_FILE = 20_000;
const MAX_TOTAL_CHARS = 80_000;

export interface ContextBlock {
  label: string;
  languageId: string;
  text: string;
  truncated: boolean;
}

export function activeSelectionBlock(): ContextBlock | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return null;
  const text = editor.document.getText(editor.selection);
  return {
    label: `${relativePath(editor.document.uri)}:${editor.selection.start.line + 1}`,
    languageId: editor.document.languageId,
    text,
    truncated: false,
  };
}

export function activeFileBlock(): ContextBlock | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  return documentBlock(editor.document);
}

export function openTabBlocks(): ContextBlock[] {
  const docs = vscode.workspace.textDocuments
    .filter((doc) => doc.uri.scheme === 'file' && !doc.isUntitled)
    .slice(0, MAX_FILES);
  return limitBlocks(docs.map(documentBlock));
}

export async function pickFileBlocks(): Promise<ContextBlock[]> {
  const files = await vscode.workspace.findFiles(
    '**/*',
    '**/{.git,node_modules,dist,out,build,coverage}/**',
    200,
  );
  const picks = await vscode.window.showQuickPick(
    files.map((uri) => ({
      label: relativePath(uri),
      uri,
    })),
    {
      canPickMany: true,
      placeHolder: `Pick up to ${MAX_FILES} files for Forge context`,
    },
  );
  if (!picks?.length) return [];
  const docs = [];
  for (const pick of picks.slice(0, MAX_FILES)) {
    docs.push(await vscode.workspace.openTextDocument(pick.uri));
  }
  return limitBlocks(docs.map(documentBlock));
}

export function nearestDiagnostic(
  uri = vscode.window.activeTextEditor?.document.uri,
  position = vscode.window.activeTextEditor?.selection.active,
): vscode.Diagnostic | null {
  if (!uri) return null;
  const diagnostics = vscode.languages.getDiagnostics(uri);
  if (diagnostics.length === 0) return null;
  if (!position) return diagnostics[0] ?? null;
  const containing = diagnostics.find((diagnostic) => diagnostic.range.contains(position));
  if (containing) return containing;
  return (
    diagnostics
      .map((diagnostic) => ({
        diagnostic,
        distance: Math.abs(diagnostic.range.start.line - position.line),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.diagnostic ?? null
  );
}

export function diagnosticsForActiveFile(): vscode.Diagnostic[] {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri ? vscode.languages.getDiagnostics(uri) : [];
}

export function diagnosticSnippet(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): string {
  const start = Math.max(0, diagnostic.range.start.line - 4);
  const end = Math.min(document.lineCount - 1, diagnostic.range.end.line + 4);
  return document.getText(new vscode.Range(start, 0, end, document.lineAt(end).text.length));
}

export function formatContextBlocks(blocks: ContextBlock[]): string {
  const truncation = blocks
    .filter((block) => block.truncated)
    .map((block) => `- ${block.label}`)
    .join('\n');
  const body = blocks
    .map((block) => {
      const note = block.truncated ? '\n[truncated]\n' : '\n';
      return `File: ${block.label}${note}\`\`\`${block.languageId}\n${block.text}\n\`\`\``;
    })
    .join('\n\n');
  return truncation ? `Some context was truncated:\n${truncation}\n\n${body}` : body;
}

export function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false) || path.basename(uri.fsPath);
}

function documentBlock(document: vscode.TextDocument): ContextBlock {
  const raw = document.getText();
  const text = raw.length > MAX_CHARS_PER_FILE ? raw.slice(0, MAX_CHARS_PER_FILE) : raw;
  return {
    label: relativePath(document.uri),
    languageId: document.languageId,
    text,
    truncated: raw.length > MAX_CHARS_PER_FILE,
  };
}

function limitBlocks(blocks: ContextBlock[]): ContextBlock[] {
  let total = 0;
  return blocks.slice(0, MAX_FILES).map((block) => {
    const remaining = MAX_TOTAL_CHARS - total;
    if (remaining <= 0) return { ...block, text: '', truncated: true };
    const text = block.text.length > remaining ? block.text.slice(0, remaining) : block.text;
    total += text.length;
    return {
      ...block,
      text,
      truncated: block.truncated || text.length < block.text.length,
    };
  });
}
