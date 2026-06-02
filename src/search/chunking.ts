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
    if (lineCount < 3 || lineCount > MAX_SYMBOL_LINES) continue;

    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const text = document.getText(symbol.range).trim();
    if (!text) continue;
    chunks.push(toChunkSeed(relativePath, document.languageId, start, end, text, symbol.name));
  }
  return chunks;
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
