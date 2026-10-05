import { describe, expect, it, vi, afterEach } from 'vitest';
import { CountTokensCounter, ServerTokenCounter } from '../../src/search/TokenCounter';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Stub fetch, recording each request body and returning a fixed token list. */
function stubFetch(tokens: number[]): { calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as unknown;
      calls.push({ url, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ tokens }),
      };
    }),
  );
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('ServerTokenCounter', () => {
  it('POSTs to /tokenize with add_special and parse_special enabled', async () => {
    const { calls } = stubFetch([1, 2, 3, 4]);
    const counter = new ServerTokenCounter(() => 'http://127.0.0.1:8091');
    await counter.count('hello');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8091/tokenize');
    expect(calls[0]!.body).toEqual({ content: 'hello', add_special: true, parse_special: true });
  });

  it('returns the token count from the tokens array', async () => {
    stubFetch([10, 20, 30]);
    const counter = new ServerTokenCounter(() => 'http://127.0.0.1:8091');
    expect(await counter.count('any text')).toBe(3);
  });

  it('caches by content: a repeat call does not re-fetch', async () => {
    const { calls } = stubFetch([1, 2]);
    const counter = new ServerTokenCounter(() => 'http://127.0.0.1:8091');
    await counter.count('same');
    await counter.count('same');
    await counter.count('different');

    // 'same' fetched once, 'different' once — the repeat 'same' is a cache hit.
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body as { content: string }).content).toBe('same');
    expect((calls[1]!.body as { content: string }).content).toBe('different');
  });

  it('throws on a non-OK response with the server detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'boom',
        json: async () => ({}),
      })),
    );
    const counter = new ServerTokenCounter(() => 'http://127.0.0.1:8091');
    await expect(counter.count('x')).rejects.toThrow(/Tokenize failed: HTTP 500 - boom/);
  });

  it('throws when the response has no tokens array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })),
    );
    const counter = new ServerTokenCounter(() => 'http://127.0.0.1:8091');
    await expect(counter.count('x')).rejects.toThrow(/no tokens array/);
  });

  it('evicts the oldest entry when the cache is full', async () => {
    // Distinct contents, each returning a distinct count so we can observe
    // which entries survive.
    let next = 0;
    const fetchMock = vi.fn(async () => {
      const n = next++;
      return { ok: true, status: 200, json: async () => ({ tokens: [n] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const counter = new ServerTokenCounter(() => 'http://127.0.0.1:8091');

    // Fill the cache to its limit (5000) with distinct texts, then add one
    // more: the first text must be evicted and re-fetched on a second call.
    const texts: string[] = [];
    for (let i = 0; i < 5001; i++) {
      const text = `text-${i}`;
      texts.push(text);
      await counter.count(text);
    }
    expect(fetchMock).toHaveBeenCalledTimes(5001);

    // The first text was evicted; counting it again must hit the network.
    await counter.count(texts[0]!);
    expect(fetchMock).toHaveBeenCalledTimes(5002);
  });
});

describe('CountTokensCounter', () => {
  it('parses the recorded Anthropic count_tokens response fixture', async () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../fixtures/strata-count-tokens-response.json'),
        'utf8',
      ),
    ) as unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => fixture })),
    );
    const counter = new CountTokensCounter(
      () => 'http://127.0.0.1:8090',
      () => 'strata-flashnext-iq3s',
    );
    expect(await counter.count('fixture probe')).toBe(54);
  });

  it('sends the configured bearer key and server model id', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        request = { url: String(url), init: init ?? {} };
        return { ok: true, status: 200, json: async () => ({ input_tokens: 17 }) };
      }),
    );
    const counter = new CountTokensCounter(
      () => 'http://127.0.0.1:8090',
      () => 'strata-server-id',
      { apiKeyProvider: () => 'secret-value' },
    );

    await counter.count('host block');

    expect(new Headers(request?.init.headers).get('authorization')).toBe('Bearer secret-value');
    expect(JSON.parse(String(request?.init.body))).toMatchObject({ model: 'strata-server-id' });
  });

  it('aborts the configured tokenize request on its timeout', async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        observedSignal = init?.signal as AbortSignal | undefined;
        if (!observedSignal) return { ok: true, status: 200, json: async () => ({ tokens: [1] }) };
        return new Promise((_resolve, reject) => {
          observedSignal!.addEventListener('abort', () => reject(observedSignal!.reason), {
            once: true,
          });
        });
      }),
    );
    const counter = new ServerTokenCounter(() => 'http://127.0.0.1:8091', { timeoutMs: 5 });

    await expect(counter.count('slow request')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(observedSignal?.aborted).toBe(true);
  });
});
