/**
 * EmbeddingGemma task-prefix formatting.
 *
 * EmbeddingGemma is trained with task-specific prompt prefixes and ranks
 * noticeably worse without them. Measured on this repo (2679 chunks, 10 queries
 * with known targets): MRR 0.384 raw vs 0.634 prefixed, recall@5 7/10 vs 8/10.
 *
 * The prefixes are model-specific — applying them to nomic-embed / bge would
 * corrupt results — so they are gated behind `embeddings.prompt_style`.
 *
 * Documents and queries take DIFFERENT prefixes. A vector is only comparable to
 * another produced under the same style, which is why the style is stamped into
 * the index file and checked before reuse.
 */
export type EmbeddingPromptStyle = 'gemma' | 'none';

export const DEFAULT_PROMPT_STYLE: EmbeddingPromptStyle = 'none';

/** Prefix for indexed content. Forge has no per-chunk titles, hence `none`. */
export function formatDocument(text: string, style: EmbeddingPromptStyle): string {
  return style === 'gemma' ? `title: none | text: ${text}` : text;
}

/** Prefix for search queries. Uses the code-retrieval task; Forge indexes code. */
export function formatQuery(text: string, style: EmbeddingPromptStyle): string {
  return style === 'gemma' ? `task: code retrieval | query: ${text}` : text;
}
