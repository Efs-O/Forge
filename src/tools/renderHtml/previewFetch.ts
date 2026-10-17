import { lookup as dnsLookup } from 'dns/promises';
import { Agent } from 'undici';
import {
  MAX_REDIRECT_HOPS,
  REQUEST_TIMEOUT_MS,
  ToolError,
  USER_AGENT,
  blockedResolvedAddress,
  defaultPinnedFetch,
  normalizedHostname,
  parseFetchUrl,
  ssrfCheck,
  type ResolvedAddress,
  type WebFetchDependencies,
} from '../fetchTool';

/**
 * Preview mode's network transport: every request the page makes is fetched
 * here, host-side, through web_fetch's SSRF guard (fetchTool.ts owns the guard;
 * this file owns how a routed browser request is fetched and capped).
 */

export interface ResourceRequest {
  method: string;
  body?: Buffer;
  headers?: Record<string, string>;
  maxBytes: number;
  httpsOnly?: boolean;
  signal?: AbortSignal;
}

export interface FetchedResource {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Host-side preview transport. Redirects are followed here, each hop through
 * the same SSRF + DNS check: handed back to Chrome, a 3xx was followed by the
 * browser itself, outside the route, and died at its DNS wall — so every
 * redirected library failed to load (measured 2026-10-08, unpkg version ranges).
 */
export async function guardedFetchResource(
  url: string,
  options: ResourceRequest,
  dependencies: WebFetchDependencies = {},
): Promise<FetchedResource> {
  let currentUrl = url;
  let request = options;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    let response: FetchedResource;
    try {
      response = await fetchResourceHop(currentUrl, request, dependencies);
    } catch (err) {
      if (hop === 0) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new ToolError(`redirect to ${currentUrl} refused: ${reason}`);
    }
    const location = response.headers['location'];
    if (response.status < 300 || response.status >= 400 || location === undefined) return response;
    currentUrl = new URL(location, currentUrl).toString();
    // 303, and 301/302 after a POST, continue as a body-less GET (fetch spec).
    if (response.status === 303 || (request.method === 'POST' && response.status <= 302)) {
      request = { method: 'GET', maxBytes: request.maxBytes };
      if (options.headers) {
        // The body is gone, so its content-type goes with it.
        request.headers = Object.fromEntries(
          Object.entries(options.headers).filter(([key]) => key.toLowerCase() !== 'content-type'),
        );
      }
    }
  }
  throw new ToolError(`web_fetch: exceeded ${MAX_REDIRECT_HOPS} redirects.`);
}

async function fetchResourceHop(
  url: string,
  options: ResourceRequest,
  dependencies: WebFetchDependencies,
): Promise<FetchedResource> {
  const blocked = ssrfCheck(url);
  if (blocked) throw new ToolError(`web_fetch: ${blocked}`);
  if (!['GET', 'POST'].includes(options.method)) {
    throw new ToolError(`web_fetch: method ${options.method} is not supported by preview.`);
  }
  const parsed = parseFetchUrl(url);
  if (typeof parsed === 'string') throw new ToolError(`web_fetch: ${parsed}`);
  if (options.httpsOnly && parsed.protocol !== 'https:') {
    throw new ToolError('web_fetch: HTTPS is required for every redirect target.');
  }
  const hostname = normalizedHostname(parsed);
  const lookup = dependencies.lookup ?? ((host) => dnsLookup(host, { all: true }));
  const addresses = await lookup(hostname);
  if (addresses.length === 0)
    throw new ToolError(`web_fetch: DNS lookup returned no addresses for ${hostname}.`);
  for (const address of addresses) {
    const reason = blockedResolvedAddress(address);
    if (reason) throw new ToolError(`web_fetch: ${reason}`);
  }
  const pinned = addresses[0] as ResolvedAddress;
  const agent = new Agent({
    connect: {
      lookup: (host, lookupOptions, callback) => {
        if (host.toLowerCase() !== hostname) {
          callback(new Error(`No vetted address for ${host}`), '', 0);
          return;
        }
        if (lookupOptions.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
    },
  });
  try {
    const response = await (dependencies.fetch ?? defaultPinnedFetch)(
      url,
      pinned,
      {
        redirect: 'manual',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        method: options.method,
        ...(options.body ? { body: options.body } : {}),
        headers: { 'User-Agent': USER_AGENT, ...options.headers },
      },
      agent,
    );
    const body = await readResponseBytes(response, options.maxBytes);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (
        ![
          'set-cookie',
          'connection',
          'transfer-encoding',
          'content-encoding',
          'content-length',
        ].includes(key.toLowerCase())
      ) {
        headers[key] = value;
      }
    });
    return { status: response.status, statusText: response.statusText, headers, body };
  } finally {
    await agent.close();
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ToolError(`web_fetch: response exceeds the ${maxBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
