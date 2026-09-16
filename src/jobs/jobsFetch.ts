/**
 * The only place a job may touch the network (D5).
 *
 * A job fetches only from a host in `allowed_hosts`; anything else is refused
 * with a message naming the config key. Responses are cached by ETag so a
 * 304 counts as "unchanged" and does not burn the API's rate budget.
 *
 * Unauthenticated by design: these are public GitHub endpoints, and a job that
 * needed a token would be a credential the scheduler can rotate — out of scope
 * for v1.
 */

import { createWriteStream } from 'fs';
import { Readable } from 'stream';

export interface JobsFetchOptions {
  /** The host a job is allowed to reach. A job may only fetch from these. */
  allowedHosts: readonly string[];
  /** ETag cache, keyed by URL. The caller owns persistence. */
  etagCache: Map<string, string>;
  /**
   * When true, fetch fresh: do not send `If-None-Match` and do not read or
   * write the ETag cache. The `llamacpp_update` action uses this to re-read a
   * release by tag so the digests it verifies against are authoritative, not a
   * stale cached observation.
   */
  forceFresh?: boolean;
  /**
   * Namespaces this caller's entries in the shared ETag cache. The scheduler
   * passes the job id: two jobs watching the same URL must not share an ETag,
   * or the second one's first run gets a 304 and never establishes a baseline.
   */
  cacheKeyPrefix?: string;
  /** Cap on the response body read into memory. Defaults to 8 MiB; injectable
   *  so the cap itself is testable without a huge fixture. */
  maxBytes?: number;
}

export interface JobsFetchResult {
  /** True when the response was a 304 (cached, unchanged). */
  notModified: boolean;
  /** The response body, empty when `notModified`. */
  body: string;
  /** The new ETag to cache, when the server sent one. */
  etag: string | null;
}

export class JobsFetchRefusedError extends Error {
  constructor(host: string) {
    super(
      `Forge: job may not fetch from "${host}" — add it to jobs.allowed_hosts in .forge/config.yaml`,
    );
    this.name = 'JobsFetchRefusedError';
  }
}

/** The maximum body a job will read into memory. A release list is tens of KB;
 *  anything near this is a misconfigured endpoint, not a check. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 10;

/** Assert a URL's host is allowed, returning the lowercased host. */
function gateHost(url: string, allowedHosts: readonly string[], what: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`Forge: job ${what} URL is not a valid URL: ${url}`);
  }
  if (!allowedHosts.some((h) => h.toLowerCase() === host)) {
    throw new JobsFetchRefusedError(host);
  }
  return host;
}

/**
 * Fetch with the host gate re-checked at EVERY redirect hop.
 *
 * `redirect: 'manual'` is the whole point: the platform's default `follow`
 * checks the gate once, on the URL we hand it, and then streams the body from
 * wherever the server points — which is not a gate at all. GitHub asset URLs
 * 302 to a CDN on a different host, so both the API path and the download path
 * need this, and having it in one place is what stops them drifting apart
 * again (they had: the download re-gated, the API did not).
 *
 * Returns the final non-redirect response and the host that served it.
 */
async function fetchGated(
  url: string,
  allowedHosts: readonly string[],
  headers: Record<string, string>,
  what: string,
): Promise<{ response: Response; host: string }> {
  let currentUrl = url;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const host = gateHost(currentUrl, allowedHosts, what);
    const response = await fetch(currentUrl, { redirect: 'manual', headers });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Forge: job ${what} redirect from ${host} had no Location header`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return { response, host };
  }
  throw new Error(`Forge: job ${what} exceeded ${MAX_REDIRECT_HOPS} redirects`);
}

/**
 * Read a response body as text, enforcing a byte cap as it streams so an
 * enormous body is never fully materialised. `response.text()` has no cap and
 * would happily buffer a gigabyte.
 */
async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Forge: job fetch response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetch a URL, gated by `allowed_hosts` and ETag-cached. Throws
 * `JobsFetchRefusedError` when the host is not allowed.
 */
export async function jobsFetch(url: string, options: JobsFetchOptions): Promise<JobsFetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': 'forge-llm-job',
    Accept: 'application/vnd.github+json',
  };
  const forceFresh = options.forceFresh === true;
  const cacheKey = options.cacheKeyPrefix ? `${options.cacheKeyPrefix}|${url}` : url;
  const cachedEtag = forceFresh ? undefined : options.etagCache.get(cacheKey);
  if (cachedEtag) headers['If-None-Match'] = cachedEtag;

  // Gated at every hop, not only on `url` — see `fetchGated`.
  const { response, host } = await fetchGated(url, options.allowedHosts, headers, 'fetch');

  if (response.status === 304) {
    return { notModified: true, body: '', etag: cachedEtag ?? null };
  }

  if (!response.ok) {
    throw new Error(`Forge: job fetch from ${host} failed with HTTP ${response.status}`);
  }

  const body = await readTextCapped(response, options.maxBytes ?? MAX_RESPONSE_BYTES);
  const etag = response.headers.get('ETag');
  if (etag && !forceFresh) options.etagCache.set(cacheKey, etag);
  return { notModified: false, body, etag };
}

/** A release asset as the `llamacpp_update` action needs it. */
export interface ReleaseAssetInfo {
  name: string;
  /** The release API digest, e.g. `sha256:<hex>`. */
  digest: string;
  /** The `github.com/.../releases/download/<tag>/<name>` URL. */
  downloadUrl: string;
}

/** A release fetched by tag, with its assets and the tag itself. */
export interface ReleaseByTag {
  tag: string;
  assets: ReleaseAssetInfo[];
}

/**
 * Fetch a release BY TAG, fresh (no ETag), and return its tag and assets.
 * The `llamacpp_update` action uses this rather than the check's cached
 * observation: the digests it verifies a download against must be authoritative,
 * so it re-reads the release from the API each time it stages a build.
 */
export async function jobsFetchReleaseByTag(
  repo: string,
  tag: string,
  options: JobsFetchOptions,
): Promise<ReleaseByTag> {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const result = await jobsFetch(url, { ...options, forceFresh: true });
  if (result.notModified) {
    throw new Error(`Forge: could not read release ${tag} for ${repo} (304)`);
  }
  const release = JSON.parse(result.body) as {
    tag_name?: unknown;
    assets?: Array<{ name?: unknown; digest?: unknown; browser_download_url?: unknown }>;
    message?: unknown;
  };
  if (typeof release.tag_name !== 'string') {
    throw new Error(
      `Forge: could not read release ${tag} for ${repo}: ${
        typeof release.message === 'string' ? release.message : 'no tag_name in response'
      }`,
    );
  }
  const assets: ReleaseAssetInfo[] = (release.assets ?? [])
    .map((a) => ({
      name: typeof a.name === 'string' ? a.name : '',
      digest: typeof a.digest === 'string' ? a.digest : '',
      downloadUrl: typeof a.browser_download_url === 'string' ? a.browser_download_url : '',
    }))
    .filter((a) => a.name.length > 0);
  return { tag: release.tag_name, assets };
}

/**
 * Download a binary asset to disk, gated by `allowed_hosts` and following
 * redirects manually so the gate is re-checked at EVERY hop, not just the
 * initial URL. GitHub asset URLs (`github.com/.../releases/download/...`) 302
 * to a CDN (`release-assets.githubusercontent.com`), so a gate that only
 * checked the first host would let the body stream from an unlisted host.
 *
 * The body is streamed to `destPath` (never held in memory) and capped at
 * `maxBytes` so a runaway download cannot fill the disk. Returns the number of
 * bytes written.
 */
export interface JobsDownloadOptions {
  allowedHosts: readonly string[];
  /** Cap on total bytes downloaded. Defaults to 2 GiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export async function jobsDownloadBinary(
  url: string,
  destPath: string,
  options: JobsDownloadOptions,
): Promise<number> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const { response, host } = await fetchGated(
    url,
    options.allowedHosts,
    { 'User-Agent': 'forge-llm-job' },
    'download',
  );
  if (!response.ok) {
    throw new Error(`Forge: job download from ${host} failed with HTTP ${response.status}`);
  }
  const body = response.body;
  if (!body) throw new Error(`Forge: job download from ${host} had no body`);
  return await streamBodyToFile(body, destPath, maxBytes);
}

/** Stream a web `ReadableStream` body to a file, enforcing a byte cap. */
async function streamBodyToFile(
  body: ReadableStream<Uint8Array>,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  const nodeStream = Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const out = createWriteStream(destPath);
  let written = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error): void => {
      nodeStream.destroy();
      out.destroy();
      reject(err);
    };
    nodeStream.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > maxBytes) {
        fail(new Error(`Forge: job download exceeded ${maxBytes} bytes`));
        return;
      }
      if (!out.write(chunk)) nodeStream.pause();
    });
    out.on('drain', () => nodeStream.resume());
    nodeStream.on('end', () => out.end());
    nodeStream.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    out.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    out.on('finish', () => resolve());
  });
  return written;
}
