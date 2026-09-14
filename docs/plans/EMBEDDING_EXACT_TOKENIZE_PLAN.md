# Guaranteeing no chunk exceeds the physical batch (search_codebase 500s)

Status: **implemented 2026-09-14, released in 0.16.0.** Options 1 and 3 shipped
together: `ServerTokenCounter` (`src/search/TokenCounter.ts`, sha1 cache bounded
FIFO) measures via `/tokenize`; `fits()` in `chunking.ts` takes the byte fast
path first and, with no counter, uses the byte bound rather than the estimate;
`EmbeddingClient` packs batches on exact counts and splits-and-retries a
multi-input 500. `CHARS_PER_TOKEN` is private to `embeddingBudget.ts`.
`INDEX_VERSION` is 5. Tests: `TokenCounter`, `chunking`, `EmbeddingClient`.

Reviewed at 0.15.48 (an unreleased local build): `src/search/embeddingBudget.ts`,
`src/search/chunking.ts`, `src/search/EmbeddingClient.ts`, `src/search/IndexManager.ts`.

## Verdict

Rank: **(1) exact `/tokenize` measurement** > **(3) a 500-driven split-and-retry
backstop** >> **(2) a lower chars/token ratio**. Ship 1 and 3 together; 1 alone
still leaves the build abortable on operational skew, 3 alone wastes GPU round
trips, 2 cannot be made correct at all.

## Why option 2 is not a fix, only a delay

A chars-per-token ratio is not an upper bound on tokens, it is an average over
a corpus. EmbeddingGemma uses SentencePiece with **byte fallback**: any
codepoint outside the vocab is emitted as one token *per UTF-8 byte*. A single
CJK / emoji / box-drawing character is 3-4 bytes, so chars-per-token drops
**below 1**. Minified JS, base64 blobs, and dense punctuation runs land between
1.0 and 1.6. The observed failure (4063 chars -> 2566 tokens, 1.58 chars/token)
is not the floor, it is ordinary TypeScript.

To be *safe* rather than *usually right*, the constant would have to be ~0.25
(one token per UTF-8 byte, worst case). That quarters every chunk and wrecks
retrieval quality. Anything between 0.25 and 2.0 is a guess that a future file
falsifies. This is why 0.15.45-0.15.48 each fixed a real bug and still failed:
they were tightening the wrong dial.

The one ratio-like fact that *is* a guarantee, and is worth keeping as a fast
path: `Buffer.byteLength(text, 'utf8') + SPECIAL_RESERVE <= window` implies the
chunk fits, because byte fallback is the worst the tokenizer can do. Use it to
skip network calls for small chunks; never use it as the splitting target.

## Option 1: measure exactly via `/tokenize`

### Endpoint contract (llama.cpp `llama-server`, current builds)

```
POST {baseUrl}/tokenize
Content-Type: application/json

{ "content": "<text>", "add_special": true, "parse_special": true }
->  200 { "tokens": [2, 1596, 235292, ...] }
```

With `"with_pieces": true` the array becomes `[{"id":2,"piece":"<bos>"}, ...]`
instead; you do not need that — only `tokens.length`.

Key properties, all from `handle_tokenize` in `server.cpp`:

- It uses `ctx_server.vocab`, i.e. **the same tokenizer as the embedding path**.
  That is the property that makes this authoritative rather than another
  estimate.
- **`add_special` defaults to `false`.** The embedding path tokenizes with
  special tokens added (BOS, and for Gemma-family a trailing EOS). Pass
  `add_special: true` or the count is short by 1-2 tokens *exactly at the
  boundary*, which is where this bug lives.
- **It does not batch per-item.** `content` may be a string, or an array of
  strings/token-ids, but `tokenize_mixed` **concatenates** the array into one
  flat token list. You get one number back, not one per input. So: one HTTP
  request per text measured. Do not try to recover per-item counts with a
  separator-token trick — the split is ambiguous whenever the content itself
  contains the separator.
- It is CPU-only, does no decode, does not occupy a slot, and returns in
  ~1-3 ms for a few KB. It is cheap in a way `/v1/embeddings` is not.

### Cost, honestly

Index build today is 1 embedding request per `EMBEDDING_BATCH_SIZE = 24` seeds
(`IndexManager.ts:180-181`), not one per chunk. Naively tokenizing every chunk
adds ~24 requests per existing request — a real regression, not a rounding
error. Two mitigations bring it back down:

1. **Byte fast path.** Skip the call when
   `byteLength(formatted) + 4 <= window`. Small chunks never touch the network.
2. **Estimate first, verify once.** Keep `estimateTokens` as the *candidate
   generator* — it decides where to cut — and use `/tokenize` only to *verify*
   the candidate, shrinking and re-verifying when it overflows. Converges in
   1-2 calls per chunk in the common case.

What you must NOT do is call `/tokenize` inside the inner grow loop of
`splitSeedToFit` (`chunking.ts:64-71`). That loop calls `formattedTokens` once
per line added; making it exact naively is one HTTP request per line of every
oversized symbol. Restructure to estimate-grow-then-verify-shrink.

### Where it plugs in

**`embeddingBudget.ts`** — keep `estimateTokens` (still useful as the candidate
generator) and add the two new primitives:

```ts
/** Tokens are never smaller than one UTF-8 byte (SentencePiece byte fallback),
 *  so this is a hard upper bound: text under it provably fits. */
export const SPECIAL_TOKEN_RESERVE = 4;
export function maxPossibleTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8') + SPECIAL_TOKEN_RESERVE;
}

export interface TokenCounter {
  /** Exact token count, as the embedding path would produce it. */
  count(text: string): Promise<number>;
}
```

**New `src/search/TokenCounter.ts`** — owns the `/tokenize` call, per the
single-point-of-truth rule; add its row to `docs/OWNERS.md`.

```ts
export class ServerTokenCounter implements TokenCounter {
  private readonly cache = new Map<string, number>(); // key: sha1(text)
  constructor(private readonly baseUrlProvider: () => string) {}

  async count(text: string): Promise<number> {
    const key = sha1(text);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const res = await fetch(`${this.baseUrlProvider()}/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, add_special: true, parse_special: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Tokenize failed: HTTP ${res.status} ${detail}`);
    }
    const payload = (await res.json()) as { tokens?: unknown[] };
    if (!Array.isArray(payload.tokens)) throw new Error('Tokenize response had no tokens array.');
    this.cache.set(key, payload.tokens.length);
    return payload.tokens.length;
  }
}
```

Surface the failure — no silent fallback to the estimator, which would
reintroduce exactly this bug. Per the no-fallbacks rule, a tokenize failure
aborts the build with the server's message. Bound the cache (e.g. 5k entries,
FIFO) so a large workspace does not grow it without limit.

**`chunking.ts`** — `buildChunkSeeds` is already `async`, so threading an
awaited counter through is mechanical. Replace `formattedTokens` with:

```ts
async function fits(text: string, max: number, style, counter): Promise<boolean> {
  const formatted = formatDocument(text, style);
  if (maxPossibleTokens(formatted) <= max) return true;   // provably fits, no call
  return (await counter.count(formatted)) <= max;
}
```

and restructure `splitSeedToFit` to:

1. `if (await fits(seed.text, max, ...)) return [seed];`
2. Pick a candidate line range using `estimateTokens` (unchanged, cheap, sync).
3. `while (!(await fits(candidate, ...)))` shrink the range — halve the line
   count, or for the single-line case halve the char count — and retry.
4. When a one-line candidate still does not fit, hand it to `splitByChars`,
   whose pieces must go through the same verify-and-shrink loop rather than
   trusting `CHARS_PER_TOKEN` arithmetic (`chunking.ts:113-114` is the current
   unverified spot).

Shrink-until-it-fits is what makes this *terminating and total*: the loop
bottoms out at a single character, which cannot exceed the window.

**`EmbeddingClient.ts`** — `splitByTokenBudget` (line 57) packs the request with
the same optimistic estimator. This is a **second, independent instance of the
same bug**: even if every chunk individually fits, a packed batch of 24 can
overflow, and a 24-input 500 is the hardest failure to attribute. Feed it exact
counts. Since `chunking` has already measured every chunk, pass the counts down
alongside the texts — or let the shared `TokenCounter` cache absorb the repeat
lookups, since the texts are identical and the sha1 cache hits. Also assert
`count <= maxTokens` per input before packing, so a bad input is caught with a
precise local message instead of at the server.

**`IndexManager.ts`** — construct one `ServerTokenCounter` next to the
`EmbeddingClient` (line 41), sharing `() => this.backend.baseUrl()`, and pass it
into both `buildChunkSeeds` (line 178) and the client. One instance means one
cache.

Bump `INDEX_VERSION` to 5: chunk boundaries change, so stored vectors are not
comparable and a rebuild is required. Update the comment at
`IndexManager.ts:13-17` with the reason.

## Option 3: the backstop you should also ship

Exact measurement can still be defeated by operational skew — the embedding
server restarting under a different model mid-build, or a future llama.cpp
whose embedding path adds a token `/tokenize` does not. Correctness should not
depend on two code paths staying in agreement forever.

In `EmbeddingClient.postOne`, when the response is a 500 whose body matches
`is too large to process` (parse out `(\d+) tokens` and `batch size: (\d+)`):

- If `inputs.length > 1`: split the array in half and retry each half. Isolates
  the offending input in `log2(n)` requests, and the build survives.
- If `inputs.length === 1`: the single chunk is too large — an indexing bug, not
  a transient. Throw, but throw with the *measured* numbers the server just
  handed back (real tokens vs. window), which is strictly more diagnostic than
  the current char-count guess at lines 96-101.

The server's own token count in the error body is ground truth. Log it.

## Trade-offs

- **Latency.** +1 HTTP request per chunk that clears the byte fast path, on a
  CPU-only endpoint. Expect a single-digit-percent index-build slowdown once the
  fast path and cache are in; expect a large one if either is skipped.
- **Coupling.** Forge starts depending on `/tokenize` existing. It is stable and
  present in every llama-server build in the supported range, and it is the same
  local process Forge already spawns — no new outbound traffic, so no Hard Stop
  is touched.
- **Ollama.** If the embedding backend is ever Ollama, `/tokenize` does not
  exist. That is why `TokenCounter` is an interface: an Ollama implementation
  can use the byte bound (`maxPossibleTokens`) as the split target — correct,
  just more conservative. Do not silently fall back to `estimateTokens`.
- **Index rebuild.** One-time and user-visible. Unavoidable: boundaries move.

## What to delete

Once the counter lands, `CHARS_PER_TOKEN` should stop being exported as a budget
constant; it survives only as a private heuristic inside the candidate
generator. Leaving it exported invites the next fix to reach for it again — and
its docstring currently claims it "OVERestimates", which is precisely the belief
this bug disproved.
