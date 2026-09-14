import { describe, expect, it, vi, afterEach } from 'vitest';
import { EmbeddingClient } from '../../src/search/EmbeddingClient';
import { estimateTokens, type TokenCounter } from '../../src/search/embeddingBudget';

/**
 * Stub fetch and record each request's `input` array plus the vectors the
 * server would return (one per input, tagged with the input length so we can
 * assert ordering across sub-batches).
 */
function stubFetch(): { requests: string[][] } {
  const requests: string[][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: string[] };
      requests.push(body.input);
      return {
        ok: true,
        json: async () => ({
          data: body.input.map((text, index) => ({
            index,
            // Vector encodes the input length so ordering is observable.
            embedding: [text.length, index],
          })),
        }),
      };
    }),
  );
  return { requests };
}

/**
 * A TokenCounter that returns the cheap estimate — for tests that validate the
 * packing algorithm independently of the exact server tokenizer.
 */
function makeEstimateCounter(): TokenCounter {
  return { count: async (text: string) => estimateTokens(text) };
}

afterEach(() => vi.unstubAllGlobals());

describe('EmbeddingClient token-budget batching', () => {
  it('sends everything in one request when it fits the budget', async () => {
    const { requests } = stubFetch();
    const client = new EmbeddingClient(
      () => 'http://127.0.0.1:8091',
      () => 'none',
      () => 2048,
    );
    // 100 chars each -> 50 est tokens each -> 500 total, well under 2048.
    await client.embedDocuments(Array.from({ length: 10 }, () => 'a'.repeat(100)));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveLength(10);
  });

  it('splits into multiple requests when the combined estimate exceeds the budget', async () => {
    const { requests } = stubFetch();
    const client = new EmbeddingClient(
      () => 'http://127.0.0.1:8091',
      () => 'none',
      () => 2048,
    );
    // 2000 chars each -> 1000 est tokens each. Two fit under 2048, three do not.
    const docs = Array.from({ length: 5 }, () => 'b'.repeat(2000));
    const vectors = await client.embedDocuments(docs);

    // 1000 * 3 = 3000 > 2048, so each request holds at most 2 docs.
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(request.reduce((sum, text) => sum + Math.ceil(text.length / 2), 0)).toBeLessThanOrEqual(
        2048,
      );
    }
    // Every input is embedded exactly once; concatenating the request inputs
    // reproduces the original order (the stub's per-request index is local, so
    // we verify order here, not via the vector payload).
    expect(requests.flat()).toEqual(docs);
    expect(vectors).toHaveLength(5);
    for (const vector of vectors) {
      expect(vector[0]).toBe(2000); // input length preserved
    }
  });

  it('preserves global ordering across sub-batches', async () => {
    const { requests } = stubFetch();
    const client = new EmbeddingClient(
      () => 'http://127.0.0.1:8091',
      () => 'none',
      () => 100, // tiny budget to force many sub-batches
    );
    const docs = ['one', 'two', 'three', 'four', 'five'];
    const vectors = await client.embedDocuments(docs);

    // Concatenated request inputs reproduce the original order.
    expect(requests.flat()).toEqual(docs);
    // Response vectors are re-indexed to their original global position.
    expect(vectors.map((v) => v[1])).toEqual([0, 1, 2, 3, 4]);
  });

  it('throws a precise local error when a single input exceeds the window', async () => {
    const { requests } = stubFetch();
    const client = new EmbeddingClient(
      () => 'http://127.0.0.1:8091',
      () => 'none',
      () => 100,
    );
    const huge = 'x'.repeat(1000); // byte bound 1004 > 100 budget
    await expect(client.embedDocuments(['small', huge, 'tiny'])).rejects.toThrow(
      /exceeds the physical batch/,
    );
    // The oversized input is caught locally before any request is sent.
    expect(requests.flat()).not.toContain(huge);
  });

  it('honours the configured budget provider (n_ctx) rather than a fixed default', async () => {
    const { requests } = stubFetch();
    const counter = makeEstimateCounter();
    let budget = 2048;
    const client = new EmbeddingClient(
      () => 'http://127.0.0.1:8091',
      () => 'none',
      () => budget,
      () => counter,
    );
    const docs = Array.from({ length: 4 }, () => 'c'.repeat(2000)); // 1000 est each
    await client.embedDocuments(docs);
    const requestsBig = requests.length;

    // Lower the budget so two docs no longer fit together (each still fits alone).
    budget = 1500;
    await client.embedDocuments(docs);
    const requestsSmall = requests.length - requestsBig;

    // 2048 fits 2 docs/request (2 requests); 1500 fits only 1 (4 requests).
    expect(requestsBig).toBe(2);
    expect(requestsSmall).toBe(4);
  });

  it('splits and retries a multi-input batch when the server reports it too large', async () => {
    // The exact counter can be defeated by operational skew (the server
    // restarting under a different model mid-build). The backstop splits the
    // batch in half and retries, so the build survives.
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { input: string[] };
        callCount++;
        if (body.input.length > 1) {
          return {
            ok: false,
            status: 500,
            text: async () =>
              '{"error":{"message":"input (3000 tokens) is too large to process. increase the physical batch size (current batch size: 2048)"}}',
            json: async () => ({}),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: body.input.map((text, index) => ({ index, embedding: [text.length, index] })),
          }),
        };
      }),
    );
    const client = new EmbeddingClient(
      () => 'http://127.0.0.1:8091',
      () => 'none',
      () => 2048,
    );
    // Two inputs that individually fit (byte bound <= 2048) but the server says
    // the combined batch is too large.
    const docs = ['a'.repeat(1000), 'b'.repeat(1000)];
    const vectors = await client.embedDocuments(docs);
    expect(vectors).toHaveLength(2);
    // The original 2-input call + 2 single-input retries = 3 calls.
    expect(callCount).toBe(3);
  });

  it('returns an empty array for no inputs without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new EmbeddingClient(() => 'http://127.0.0.1:8091', () => 'none', () => 2048);
    await expect(client.embedDocuments([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
