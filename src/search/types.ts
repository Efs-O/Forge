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
  version: 1;
  workspaceRoot: string;
  modelPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  maxFileSizeKb: number;
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
