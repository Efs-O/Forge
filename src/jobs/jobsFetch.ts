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

export interface JobsFetchOptions {
  /** The host a job is allowed to reach. A job may only fetch from these. */
  allowedHosts: readonly string[];
  /** ETag cache, keyed by URL. The caller owns persistence. */
  etagCache: Map<string, string>;
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

/**
 * Fetch a URL, gated by `allowed_hosts` and ETag-cached. Throws
 * `JobsFetchRefusedError` when the host is not allowed.
 */
export async function jobsFetch(url: string, options: JobsFetchOptions): Promise<JobsFetchResult> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`Forge: job fetch URL is not a valid URL: ${url}`);
  }

  if (!options.allowedHosts.some((h) => h.toLowerCase() === host)) {
    throw new JobsFetchRefusedError(host);
  }

  const headers: Record<string, string> = {
    'User-Agent': 'forge-llm-job',
    Accept: 'application/vnd.github+json',
  };
  const cachedEtag = options.etagCache.get(url);
  if (cachedEtag) headers['If-None-Match'] = cachedEtag;

  const response = await fetch(url, { headers });

  if (response.status === 304) {
    return { notModified: true, body: '', etag: cachedEtag ?? null };
  }

  if (!response.ok) {
    throw new Error(`Forge: job fetch from ${host} failed with HTTP ${response.status}`);
  }

  const body = await response.text();
  const etag = response.headers.get('ETag');
  if (etag) options.etagCache.set(url, etag);
  return { notModified: false, body, etag };
}
