import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JobsFetchRefusedError,
  MAX_ETAG_CACHE_ENTRIES,
  jobsDownloadBinary,
  jobsFetch,
} from '../../src/jobs/jobsFetch';
import { githubReleaseCheck } from '../../src/jobs/checks/github';

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

function okResponse(body: string, etag?: string): Response {
  const headers = new Headers();
  if (etag) headers.set('ETag', etag);
  return new Response(body, { status: 200, headers });
}

describe('jobsFetch (D5 host gate)', () => {
  it('refuses a host not in allowed_hosts, naming the config key', async () => {
    await expect(
      jobsFetch('https://evil.example.com/x', {
        allowedHosts: ['api.github.com'],
        etagCache: new Map(),
      }),
    ).rejects.toThrow(JobsFetchRefusedError);
    await expect(
      jobsFetch('https://evil.example.com/x', {
        allowedHosts: ['api.github.com'],
        etagCache: new Map(),
      }),
    ).rejects.toThrow(/jobs\.allowed_hosts/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('re-gates at every redirect hop, like the download path does', async () => {
    // The API path used to call fetch() with the platform default
    // `redirect: 'follow'`, which checks the gate once and then reads the body
    // from wherever the server points. That is not a gate.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/x' } }),
    );
    await expect(
      jobsFetch('https://api.github.com/x', {
        allowedHosts: ['api.github.com'],
        etagCache: new Map(),
      }),
    ).rejects.toThrow(JobsFetchRefusedError);
    // The redirect target was never fetched.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to an allowed host', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://api.github.com/moved' } }),
      )
      .mockResolvedValueOnce(okResponse('moved-body'));
    const result = await jobsFetch('https://api.github.com/x', {
      allowedHosts: ['api.github.com'],
      etagCache: new Map(),
    });
    expect(result.body).toBe('moved-body');
  });

  it('caps the response body instead of buffering it without limit', async () => {
    const huge = 'x'.repeat(200);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse(huge));
    await expect(
      jobsFetch('https://api.github.com/x', {
        allowedHosts: ['api.github.com'],
        etagCache: new Map(),
        maxBytes: 100,
      }),
    ).rejects.toThrow(/exceeded 100 bytes/);
  });

  it('namespaces the ETag cache per caller, so two jobs on one URL do not share it', async () => {
    // A shared cache hands the SECOND job a 304 on its very first run, leaving
    // it with no baseline while the server says "nothing new" — a state the
    // check cannot tell apart from a real no-change.
    const etagCache = new Map();
    const url = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
    // A fresh Response per call: a body stream can only be read once.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve(okResponse('body', 'W/"v1"')),
    );

    await jobsFetch(url, { allowedHosts: ['api.github.com'], etagCache, cacheKeyPrefix: 'job-a' });
    const second = await jobsFetch(url, {
      allowedHosts: ['api.github.com'],
      etagCache,
      cacheKeyPrefix: 'job-b',
    });

    expect(second.body).toBe('body');
    // job-b sent no If-None-Match, because job-a's ETag is not its own.
    const lastCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const headers = (lastCall?.[1] as { headers: Record<string, string> }).headers;
    expect(headers['If-None-Match']).toBeUndefined();
    expect([...etagCache.keys()]).toEqual([`job-a|${url}`, `job-b|${url}`]);
  });

  it('allows a listed host, case-insensitively', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse('body'));
    const result = await jobsFetch('https://API.GITHUB.com/repo', {
      allowedHosts: ['api.github.com'],
      etagCache: new Map(),
    });
    expect(result.body).toBe('body');
  });

  it('sends If-None-Match when an ETag is cached, and a 304 returns its body', async () => {
    const cache = new Map([[
      'https://api.github.com/repo',
      { etag: 'W/"abc"', body: 'cached body' },
    ]]);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(null, { status: 304 }));
    const result = await jobsFetch('https://api.github.com/repo', {
      allowedHosts: ['api.github.com'],
      etagCache: cache,
    });
    expect(result.body).toBe('cached body');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('W/"abc"');
  });

  it('caches the ETag from a 200 response', async () => {
    const cache = new Map();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse('body', 'W/"new"'));
    await jobsFetch('https://api.github.com/repo', {
      allowedHosts: ['api.github.com'],
      etagCache: cache,
    });
    expect(cache.get('https://api.github.com/repo')).toEqual({ etag: 'W/"new"', body: 'body' });
  });

  it('re-derives a release observation from a cached body after a 304', async () => {
    const url = 'https://api.github.com/repos/mw00/project-maya/releases/latest';
    const latest = JSON.stringify({ tag_name: 'v1.1.60', published_at: '2026-11-12', assets: [] });
    const cache = new Map();
    const last = JSON.stringify({ tag: 'v1.1.56', published_at: null, assets: [], body: '' });
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(okResponse(latest, '"e1"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const ctx = {
      fetch: (requestUrl: string) =>
        jobsFetch(requestUrl, { allowedHosts: ['api.github.com'], etagCache: cache }),
      etagCache: cache,
      allowedHosts: ['api.github.com'],
    };

    const first = await githubReleaseCheck({ kind: 'github_release', repo: 'mw00/project-maya' }, last, ctx);
    expect(first).toEqual({
      observation: JSON.stringify({ tag: 'v1.1.60', published_at: '2026-11-12', assets: [], body: '' }),
      changed: true,
      summary: 'latest release is v1.1.60',
    });
    const second = await githubReleaseCheck({ kind: 'github_release', repo: 'mw00/project-maya' }, last, ctx);
    expect(second).toEqual(first);
    const third = await githubReleaseCheck({ kind: 'github_release', repo: 'mw00/project-maya' }, first.observation, ctx);
    expect(third).toEqual({ ...first, changed: false });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ 'If-None-Match': '"e1"' }),
    });
  });

  it('retries a 304 without a cached body once without If-None-Match', async () => {
    const url = 'https://api.github.com/repo';
    const cache = new Map([[url, { etag: '"lost"', body: undefined }]]);
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(okResponse('fresh body', '"fresh"'));
    const result = await jobsFetch(url, { allowedHosts: ['api.github.com'], etagCache: cache });
    expect(result).toEqual({ body: 'fresh body', etag: '"fresh"' });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({
      headers: expect.not.objectContaining({ 'If-None-Match': expect.anything() }),
    });
  });

  it('evicts the oldest ETag entry past the cap, and that URL then fetches fresh', async () => {
    const cache = new Map();
    const urlFor = (i: number): string => `https://api.github.com/repo/${i}`;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      Promise.resolve(okResponse(`body ${url}`, `"${url}"`)),
    );
    for (let i = 0; i <= MAX_ETAG_CACHE_ENTRIES; i++) {
      await jobsFetch(urlFor(i), { allowedHosts: ['api.github.com'], etagCache: cache });
    }
    expect(cache.size).toBe(MAX_ETAG_CACHE_ENTRIES);
    expect(cache.has(urlFor(0))).toBe(false);
    expect(cache.has(urlFor(1))).toBe(true);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      okResponse('fresh body', '"fresh"'),
    );
    const result = await jobsFetch(urlFor(0), { allowedHosts: ['api.github.com'], etagCache: cache });
    expect(result).toEqual({ body: 'fresh body', etag: '"fresh"' });
    const headers = (
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as {
        headers: Record<string, string>;
      }
    ).headers;
    expect(headers['If-None-Match']).toBeUndefined();
  });

  it('a non-2xx/304 response throws with the status', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('rate limited', { status: 403 }),
    );
    await expect(
      jobsFetch('https://api.github.com/repo', {
        allowedHosts: ['api.github.com'],
        etagCache: new Map(),
      }),
    ).rejects.toThrow(/403/);
  });
});

/** A 200 response whose body streams the given bytes. */
function bodyResponse(bytes: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('jobsDownloadBinary (D5 redirect re-gate + byte cap)', () => {
  let dest: string;
  beforeEach(() => {
    dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dl-')), 'asset.zip');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  });

  it('downloads to disk when the host is allowed', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      bodyResponse(new TextEncoder().encode('zipdata')),
    );
    const written = await jobsDownloadBinary('https://api.github.com/a.zip', dest, {
      allowedHosts: ['api.github.com'],
    });
    expect(written).toBe(7);
    expect(fs.readFileSync(dest, 'utf8')).toBe('zipdata');
  });

  it('re-gates at every redirect hop (a 302 to an unlisted host is refused)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.evil.example/a.zip' },
        }),
      )
      .mockResolvedValueOnce(bodyResponse(new TextEncoder().encode('x')));
    await expect(
      jobsDownloadBinary('https://api.github.com/a.zip', dest, { allowedHosts: ['api.github.com'] }),
    ).rejects.toThrow(JobsFetchRefusedError);
    // The second hop was never fetched.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('follows a redirect to an allowed host', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://release-assets.githubusercontent.com/a.zip' },
        }),
      )
      .mockResolvedValueOnce(bodyResponse(new TextEncoder().encode('zipdata')));
    await jobsDownloadBinary('https://api.github.com/a.zip', dest, {
      allowedHosts: ['api.github.com', 'release-assets.githubusercontent.com'],
    });
    expect(fs.readFileSync(dest, 'utf8')).toBe('zipdata');
  });

  it('refuses a download that exceeds the byte cap', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      bodyResponse(new Uint8Array(1024).fill(1)),
    );
    await expect(
      jobsDownloadBinary('https://api.github.com/a.zip', dest, {
        allowedHosts: ['api.github.com'],
        maxBytes: 512,
      }),
    ).rejects.toThrow(/exceeded 512 bytes/);
  });
});
