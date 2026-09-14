import type { EmbeddingPromptStyle } from './embeddingPrompts';

export interface SearchChunk {
  id: string;
  path: string;
  languageId: string;
  startLine: number;
  endLine: number;
  hash: string;
  text: string;
  symbolName?: string;
  embedding: number[];
}

export interface SearchIndexFile {
  /**
   * Bump whenever chunk boundaries or stored fields change: an index built by
   * older code stays structurally valid but no longer means the same thing, and
   * nothing else in isCompatibleIndex would catch it.
   * 2 — symbol chunks include their leading doc comment.
   * 3 — char-split fallback re-chunks a single over-long line (e.g. a
   *      minified JSON blob) that the line-split alone cannot break.
   * 4 — fit pass measures the formatted text (prompt prefix included), so a
   *      raw chunk at the budget edge no longer overflows once prefixed.
   * 5 — fit pass measures the formatted text with the server's EXACT tokenizer
   *      (via /tokenize), not a chars-per-token estimate. The estimate
   *      undercounted dense content, so a chunk estimated to fit overflowed the
   *      physical batch once the real tokenizer ran.
   */
  version: 5;
  workspaceRoot: string;
  modelPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  maxFileSizeKb: number;
  /**
   * Prompt style the chunks were embedded with. Vectors are only comparable to
   * a query embedded under the same style, so a change here must invalidate the
   * index — see IndexManager.isCompatibleIndex.
   */
  promptStyle: EmbeddingPromptStyle;
  builtAt: number;
  chunks: SearchChunk[];
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  symbolName?: string;
}

export interface SearchResultSummary {
  filesIndexed: number;
  chunksIndexed: number;
}
