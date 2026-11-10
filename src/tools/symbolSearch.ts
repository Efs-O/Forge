/** Whole-word workspace search used to prime language-server project files. */
import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveRipgrep } from './RipgrepResolver';
import { SEARCH_EXCLUDES } from './searchScope';

export interface PrimedSymbol {
  name?: string;
  files: string[];
}

/** Select the identifier TypeScript associates with a cursor position. */
function wordRangeAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.Range | undefined {
  const line = document.lineAt(position.line).text;
  const character = line[position.character];
  const wordCharacter = /[\p{L}\p{N}_$]/u;
  if (character && wordCharacter.test(character)) {
    return document.getWordRangeAtPosition(position);
  }
  if (character && /\s/u.test(character)) {
    let nextCharacter = position.character;
    while (nextCharacter < line.length && /\s/u.test(line[nextCharacter] ?? '')) {
      nextCharacter += 1;
    }
    if (wordCharacter.test(line[nextCharacter] ?? '')) {
      const range = document.getWordRangeAtPosition(
        new vscode.Position(position.line, nextCharacter),
      );
      return range?.start.character === nextCharacter ? range : undefined;
    }
    return undefined;
  }
  return document.getWordRangeAtPosition(position);
}

/** Search with search_code's ripgrep executable and ignore policy. */
export async function searchSymbolFiles(name: string): Promise<string[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  const root = folder.uri.fsPath;
  const resolution = resolveRipgrep(vscode.env.appRoot);
  const args = [
    '--files-with-matches',
    '--fixed-strings',
    '--word-regexp',
    '--hidden',
    ...SEARCH_EXCLUDES.flatMap((glob) => ['--glob', glob]),
    '--regexp',
    name,
    '.',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(resolution.command, [...(resolution.argsPrefix ?? []), ...args], {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer | string) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code: number | null) => {
      if (code === 0 || code === 1) {
        resolve(
          stdout
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((file) => path.resolve(root, file)),
        );
      } else reject(new Error(`code_intel text search failed (${code}): ${stderr.trim()}`));
    });
  });
}

/** Open all text-search hits before asking the language server about a symbol. */
export async function primeSymbolAtPosition(
  uri: vscode.Uri,
  position: vscode.Position,
  searchFiles: (name: string) => Promise<string[]> = searchSymbolFiles,
): Promise<PrimedSymbol> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    return { files: [] };
  }
  if (!document || !document.getWordRangeAtPosition || !document.getText || !document.lineAt) {
    return { files: [] };
  }
  const wordRange = wordRangeAtPosition(document, position);
  if (!wordRange) return { files: [] };
  const name = document.getText(wordRange);
  if (!name) return { files: [] };
  const files = await searchFiles(name);
  await Promise.all(
    files.map(async (file) => {
      try {
        await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      } catch {
        // A search hit may be unreadable or disappear during the search.
      }
    }),
  );
  return { name, files };
}

/** Re-check a renamed identifier and format any remaining text-search hits. */
export async function remainingSymbolFiles(name: string): Promise<string[]> {
  return searchSymbolFiles(name);
}
