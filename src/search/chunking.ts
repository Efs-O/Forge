import { createHash } from 'crypto';
import * as vscode from 'vscode';
import {
  DEFAULT_EMBEDDING_WINDOW,
  estimateTokens,
  maxPossibleTokens,
  type TokenCounter,
} from './embeddingBudget';
import {
  DEFAULT_PROMPT_STYLE,
  formatDocument,
  type EmbeddingPromptStyle,
} from './embeddingPrompts';

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
  maxTokens: number = DEFAULT_EMBEDDING_WINDOW,
  promptStyle: EmbeddingPromptStyle = DEFAULT_PROMPT_STYLE,
  tokenCounter: TokenCounter | null = null,
): Promise<ChunkSeed[]> {
  const symbolChunks = await buildSymbolChunks(document, relativePath);
  const seeds = symbolChunks.length > 0 ? symbolChunks : buildLineChunks(document, relativePath);
  // A single seed can still exceed the physical batch on its own (a 120-line
  // symbol is ~3200 tokens > the 2048 window). Split any oversized seed into
  // line sub-chunks that fit, so no chunk 500s even when it is the only one in
  // its request. The fit is measured on the FORMATTED text (prefix included)
  // because that is what the request layer actually embeds — a raw chunk at
  // the budget edge can still overflow once the prompt prefix is added.
  const out: ChunkSeed[] = [];
  for (const seed of seeds) {
    out.push(...(await splitSeedToFit(seed, maxTokens, promptStyle, tokenCounter)));
  }
  return out;
}

/**
 * Whether `text` fits the token budget ONCE FORMATTED (prompt prefix included)
 * — i.e. what the embedding server actually receives. The fit is exact when a
 * `tokenCounter` is supplied (measured via the server's own tokenizer);
 * otherwise it falls back to the byte bound (`maxPossibleTokens`), a provable
 * upper bound that is conservative but safe. A raw chunk at the budget edge
 * overflows once the prefix is added, so the formatted text is what we test.
 */
async function fits(
  text: string,
  maxTokens: number,
  style: EmbeddingPromptStyle,
  counter: TokenCounter | null,
): Promise<boolean> {
  const formatted = formatDocument(text, style);
  if (maxPossibleTokens(formatted) <= maxTokens) return true; // provably fits, no call
  if (!counter) return false; // no counter: conservative byte bound
  return (await counter.count(formatted)) <= maxTokens;
}

/**
 * Return `seed` unchanged if it fits the token budget, otherwise split it into
 * line-based sub-chunks (with the usual overlap) that each fit. The leading
 * doc comment stays with the first sub-chunk, and the symbol name is retained
 * on every fragment so a large symbol is still findable by name.
 */
async function splitSeedToFit(
  seed: ChunkSeed,
  maxTokens: number,
  style: EmbeddingPromptStyle,
  counter: TokenCounter | null,
): Promise<ChunkSeed[]> {
  if (await fits(seed.text, maxTokens, style, counter)) return [seed];

  const lines = seed.text.split('\n');
  const subSeeds: ChunkSeed[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start + 1;
    // Grow a candidate using the CHEAP estimate (no network) — it decides where
    // to cut. The estimate undercounts dense content, so the candidate can be
    // slightly too big; the verify-and-shrink below corrects it with the exact
    // counter. Estimating the grow keeps this O(lines) in cheap work instead of
    // one tokenizer call per line.
    while (
      end < lines.length &&
      estimateTokens(formatDocument(lines.slice(start, end + 1).join('\n'), style)) <= maxTokens
    ) {
      end++;
    }
    // Verify-and-shrink: halve the line count until the exact counter (or byte
    // bound) says the candidate fits. O(log n) counter calls, not O(n).
    let subText = lines.slice(start, end).join('\n');
    let subFits = await fits(subText, maxTokens, style, counter);
    while (!subFits && end - start > 1) {
      end = start + Math.max(1, Math.floor((end - start) / 2));
      subText = lines.slice(start, end).join('\n');
      subFits = await fits(subText, maxTokens, style, counter);
    }
    const subStartLine = seed.startLine + start;
    const subEndLine = seed.startLine + (end - 1);
    // A single line can still exceed the window on its own (e.g. minified JSON
    // or a long data blob on one line). The line-based split cannot break it —
    // `end` stays at `start + 1` and the sub-chunk is the whole line — so split
    // it by character into pieces that fit. Each piece is independently
    // tokenized, so cutting at arbitrary character boundaries is safe.
    if (!subFits) {
      for (const piece of await splitByCharsFit(subText, maxTokens, style, counter)) {
        subSeeds.push(
          toChunkSeed(seed.path, seed.languageId, subStartLine, subEndLine, piece, seed.symbolName),
        );
      }
    } else {
      subSeeds.push(
        toChunkSeed(seed.path, seed.languageId, subStartLine, subEndLine, subText, seed.symbolName),
      );
    }
    if (end >= lines.length) break;
    // Overlap so a symbol split across the boundary is not cut mid-expression.
    start = Math.max(end - CHUNK_OVERLAP_LINES, start + 1);
  }
  return subSeeds;
}

/**
 * Split a single over-long string into character-based pieces that each fit the
 * token budget. Last-resort fallback for a line too long for the window, where
 * the line-based split has no line boundary to cut on. No overlap: the content
 * is typically minified data (not code with cross-boundary structure), and each
 * piece is large enough to embed meaningfully on its own.
 *
 * Each piece is embedded WITH the prompt prefix, so the piece's raw budget is
 * the window minus the prefix's tokens.
 */
async function splitByCharsFit(
  text: string,
  maxTokens: number,
  style: EmbeddingPromptStyle,
  counter: TokenCounter | null,
): Promise<string[]> {
  const pieces: string[] = [];
  let start = 0;
  let hint = text.length;
  while (start < text.length) {
    let end = Math.min(text.length, start + hint);
    let candidate = text.slice(start, end);
    let ok = await fits(candidate, maxTokens, style, counter);
    // Verify-and-shrink: halve the piece until it fits. The size carries
    // forward (`hint`) so subsequent pieces start near the right size instead
    // of re-halving from the full run.
    while (!ok && end - start > 1) {
      end = start + Math.max(1, Math.floor((end - start) / 2));
      candidate = text.slice(start, end);
      ok = await fits(candidate, maxTokens, style, counter);
    }
    if (!ok) {
      // A single character still does not fit: the window is smaller than the
      // special-token reserve. Cannot happen for a 2048 window, but guard
      // against an infinite loop rather than spin.
      break;
    }
    pieces.push(candidate);
    hint = end - start;
    start = end;
  }
  return pieces;
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
