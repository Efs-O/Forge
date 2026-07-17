import { createHash } from 'crypto';
import * as vscode from 'vscode';

export interface ChunkSeed {
  id: string;
  path: string;
  languageId: string;
  startLine: number;
  endLine: number;
  hash: string;
  text: string;
  symbolName?: string;
}

const MAX_CHUNK_LINES = 80;
const CHUNK_OVERLAP_LINES = 12;
const MAX_SYMBOL_LINES = 120;
/** Cap on a leading comment block, so a licence header is not pulled into every symbol. */
const MAX_COMMENT_LINES = 30;

export async function buildChunkSeeds(
  document: vscode.TextDocument,
  relativePath: string,
): Promise<ChunkSeed[]> {
  const symbolChunks = await buildSymbolChunks(document, relativePath);
  if (symbolChunks.length > 0) return symbolChunks;
  return buildLineChunks(document, relativePath);
}

async function buildSymbolChunks(
  document: vscode.TextDocument,
  relativePath: string,
): Promise<ChunkSeed[]> {
  let symbols: vscode.DocumentSymbol[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );
  } catch {
    return [];
  }
  if (!Array.isArray(symbols) || symbols.length === 0) return [];

  const flat = flattenSymbols(symbols);
  const chunks: ChunkSeed[] = [];
  const seen = new Set<string>();
  for (const symbol of flat) {
    const start = symbol.range.start.line + 1;
    const end = symbol.range.end.line + 1;
    const lineCount = end - start + 1;
    // Sized on the symbol itself: the doc comment below only grows the text,
    // it must not change which symbols are eligible for indexing.
    if (lineCount < 3 || lineCount > MAX_SYMBOL_LINES) continue;

    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // DocumentSymbol.range starts at the declaration, so a leading JSDoc is
    // excluded — dropping the prose that best describes what the symbol does.
    const commentLine = findCommentStart(document, symbol.range.start.line);
    const textRange = new vscode.Range(new vscode.Position(commentLine, 0), symbol.range.end);
    const text = document.getText(textRange).trim();
    if (!text) continue;
    chunks.push(
      toChunkSeed(relativePath, document.languageId, commentLine + 1, end, text, symbol.name),
    );
  }
  return chunks;
}

/**
 * First line (0-based) of the comment block directly above `startLine`, or
 * `startLine` itself when none is attached. A blank line breaks attachment:
 * a detached comment may describe something else entirely.
 */
function findCommentStart(document: vscode.TextDocument, startLine: number): number {
  let line = startLine - 1;
  if (line < 0) return startLine;

  const textAt = (n: number): string => document.lineAt(n).text.trim();
  const limit = Math.max(0, startLine - MAX_COMMENT_LINES);

  // Block comment: walk up from a closing */ to its opening /*.
  if (textAt(line).endsWith('*/')) {
    while (line >= limit) {
      if (textAt(line).startsWith('/*')) return line;
      line -= 1;
    }
    return startLine; // unterminated within the cap — leave the symbol as-is
  }

  // Line comments: take the contiguous run.
  if (!textAt(line).startsWith('//')) return startLine;
  while (line - 1 >= limit && textAt(line - 1).startsWith('//')) line -= 1;
  return line;
}

function flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const flat: vscode.DocumentSymbol[] = [];
  for (const symbol of symbols) {
    flat.push(symbol);
    if (symbol.children.length > 0) flat.push(...flattenSymbols(symbol.children));
  }
  return flat;
}

function buildLineChunks(document: vscode.TextDocument, relativePath: string): ChunkSeed[] {
  const totalLines = document.lineCount;
  const chunks: ChunkSeed[] = [];
  for (let start = 0; start < totalLines; start += MAX_CHUNK_LINES - CHUNK_OVERLAP_LINES) {
    const endExclusive = Math.min(totalLines, start + MAX_CHUNK_LINES);
    const lines: string[] = [];
    for (let line = start; line < endExclusive; line += 1) {
      lines.push(document.lineAt(line).text);
    }
    const text = lines.join('\n').trim();
    if (!text) continue;
    chunks.push(toChunkSeed(relativePath, document.languageId, start + 1, endExclusive, text));
    if (endExclusive >= totalLines) break;
  }
  return chunks;
}

function toChunkSeed(
  relativePath: string,
  languageId: string,
  startLine: number,
  endLine: number,
  text: string,
  symbolName?: string,
): ChunkSeed {
  const hash = createHash('sha1').update(text).digest('hex');
  return {
    id: `${relativePath}:${startLine}-${endLine}:${hash.slice(0, 12)}`,
    path: relativePath,
    languageId,
    startLine,
    endLine,
    hash,
    text,
    ...(symbolName ? { symbolName } : {}),
  };
}
