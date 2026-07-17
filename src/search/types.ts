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
   */
  version: 2;
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
