/**
 * Single source of truth for the embedding model's physical batch, in tokens.
 *
 * llama.cpp's /v1/embeddings combines every string in the `input` array into
 * one physical batch per slot, and in --embeddings + pooling mode the whole
 * batch must fit --ubatch-size (which composeEmbeddingServerArgs pins to
 * embeddings.n_ctx). There is no auto-splitting, so two things must both stay
 * under the window:
 *
 *   1. each individual chunk (a single chunk in a 1-chunk request still
 *      overflows if it is bigger than the window), and
 *   2. the combined estimate of all chunks packed into one request.
 *
 * Both are bounded here so they cannot drift apart.
 */

/** Fallback physical batch when embeddings.n_ctx is not configured. */
export const DEFAULT_EMBEDDING_WINDOW = 2048;

/**
 * Chars-per-token used by `estimateTokens` as a CANDIDATE GENERATOR only —
 * never as a budget. It undercounts for dense content (minified JS, base64,
 * CJK via SentencePiece byte fallback), which is safe here: the candidate is
 * then verified against the exact tokenizer (or the byte bound) before it is
 * trusted. Do not use this as a fit test.
 */
const CHARS_PER_TOKEN = 2;

/**
 * Cheap estimate of the token count of `text`. Undercounts for dense content,
 * so it is only safe as a candidate generator (where to cut), never as a fit
 * test. Use `maxPossibleTokens` for a provable upper bound, or the exact
 * `TokenCounter` for the real count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Reserve for the special tokens the embedding path adds (BOS, and a trailing
 * EOS for Gemma-family). Added to a byte count to form a hard upper bound.
 */
export const SPECIAL_TOKEN_RESERVE = 4;

/**
 * A hard upper bound on the token count of `text`. SentencePiece byte fallback
 * means a token is never smaller than one UTF-8 byte, so `byteLength` bounds
 * the token count from above; the reserve covers the special tokens. Text whose
 * bound is under the window provably fits without a tokenizer call.
 */
export function maxPossibleTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8') + SPECIAL_TOKEN_RESERVE;
}

/**
 * Exact token count, as the embedding path would produce it. The default
 * implementation (`ServerTokenCounter`) measures via llama-server's `/tokenize`
 * endpoint, which uses the same vocab as the embedding path.
 */
export interface TokenCounter {
  count(text: string): Promise<number>;
}
