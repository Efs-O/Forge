import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsFetchRefusedError, jobsDownloadBinary, jobsFetch } from '../../src/jobs/jobsFetch';

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

  it('allows a listed host, case-insensitively', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse('body'));
    const result = await jobsFetch('https://API.GITHUB.com/repo', {
      allowedHosts: ['api.github.com'],
      etagCache: new Map(),
    });
    expect(result.body).toBe('body');
    expect(result.notModified).toBe(false);
  });

  it('sends If-None-Match when an ETag is cached, and a 304 counts as unchanged', async () => {
    const cache = new Map<string, string>([['https://api.github.com/repo', 'W/"abc"']]);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(null, { status: 304 }));
    const result = await jobsFetch('https://api.github.com/repo', {
      allowedHosts: ['api.github.com'],
      etagCache: cache,
    });
    expect(result.notModified).toBe(true);
    expect(result.body).toBe('');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('W/"abc"');
  });

  it('caches the ETag from a 200 response', async () => {
    const cache = new Map<string, string>();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse('body', 'W/"new"'));
    await jobsFetch('https://api.github.com/repo', {
      allowedHosts: ['api.github.com'],
      etagCache: cache,
    });
    expect(cache.get('https://api.github.com/repo')).toBe('W/"new"');
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
