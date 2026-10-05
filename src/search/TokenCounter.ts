import { createHash } from 'crypto';
import { z } from 'zod';
import type { TokenCounter } from './embeddingBudget';

const CountTokensResponseSchema = z.object({ input_tokens: z.number().int().nonnegative() });

/**
 * Measures token counts via llama-server's `/tokenize` endpoint, which uses the
 * SAME vocab as the embedding path — so the count is authoritative, not another
 * estimate. This is the fix for the recurring "input too large" 500s: the old
 * chars-per-token heuristic undercounted dense content (minified JS, base64,
 * CJK via byte fallback), so a chunk estimated to fit overflowed once the real
 * tokenizer ran.
 *
 * Two traps this handles:
 *   - `add_special` defaults to `false` on the server; the embedding path adds
 *     BOS (+EOS for Gemma), so we pass `add_special: true` or the count is
 *     short by 1-2 tokens exactly at the boundary.
 *   - the endpoint does NOT batch per-item: an array `content` is concatenated
 *     into one flat token list. So this is one request per text measured.
 *
 * It is CPU-only, does no decode, occupies no slot, and returns in ~1-3 ms for
 * a few KB — cheap in a way `/v1/embeddings` is not. A sha1 cache dedupes
 * repeat lookups (the chunker and the request layer measure the same texts).
 */
export class ServerTokenCounter implements TokenCounter {
  private readonly cache = new Map<string, number>();
  private static readonly CACHE_LIMIT = 5000;

  constructor(
    private readonly baseUrlProvider: () => string,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  async count(text: string): Promise<number> {
    const key = createHash('sha1').update(text).digest('hex');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const response = await fetch(`${this.baseUrlProvider()}/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, add_special: true, parse_special: true }),
      ...(this.options.timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(this.options.timeoutMs) }
        : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // No silent fallback to the estimator — that would reintroduce the bug.
      throw new Error(`Tokenize failed: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`);
    }

    const payload = (await response.json()) as { tokens?: unknown[] };
    if (!Array.isArray(payload.tokens)) {
      throw new Error('Tokenize response had no tokens array.');
    }

    const n = payload.tokens.length;
    if (this.cache.size >= ServerTokenCounter.CACHE_LIMIT) {
      // FIFO evict the oldest entry (Map preserves insertion order).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, n);
    return n;
  }
}

/** Measures OpenAI-compatible servers that expose Anthropic's count_tokens route. */
export class CountTokensCounter implements TokenCounter {
  constructor(
    private readonly endpointProvider: () => string,
    private readonly modelProvider: () => string,
    private readonly options: {
      apiKeyProvider?: () => string | undefined | Promise<string | undefined>;
      timeoutMs?: number;
    } = {},
  ) {}

  async count(text: string): Promise<number> {
    const endpoint = this.endpointProvider().replace(/\/+$/u, '');
    const apiKey = await this.options.apiKeyProvider?.();
    const response = await fetch(`${endpoint}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.modelProvider(),
        messages: [{ role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `count_tokens failed at ${endpoint}: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`,
      );
    }
    const parsed = CountTokensResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`count_tokens response from ${endpoint} had no valid input_tokens integer.`);
    }
    return parsed.data.input_tokens;
  }
}
