import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import type { RegisteredTool } from './ToolRegistry';
import { Agent, fetch as undiciFetch } from 'undici';

// ── SSRF guard ────────────────────────────────────────────────────────────────

class ToolError extends Error {}

const BLOCKED_SCHEMES = ['file://', 'data:', 'javascript:'];
const MAX_REDIRECT_HOPS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'Forge-VSCode/0.16 (local-llm assistant)';

interface ResolvedAddress {
  address: string;
  family: number;
}

interface RequestInitWithSignal {
  redirect: 'manual';
  signal: AbortSignal;
  headers: { 'User-Agent': string };
}

type PinnedFetch = (
  url: string,
  address: ResolvedAddress,
  init: RequestInitWithSignal,
  agent: Agent,
) => Promise<Response>;

interface WebFetchDependencies {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  fetch?: PinnedFetch;
}

function parseFetchUrl(value: string): URL | string {
  for (const scheme of BLOCKED_SCHEMES) {
    if (value.toLowerCase().startsWith(scheme)) return `Blocked scheme: ${scheme}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Invalid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Blocked scheme: ${url.protocol}`;
  }
  const hostname = normalizedHostname(url);
  if (!hostname.includes('.')) return `Blocked: hostname has no dot: ${hostname}`;
  if (isIP(hostname) !== 0) return `Blocked: raw IP address not permitted: ${hostname}`;
  return url;
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function parseIpv6(address: string): number[] | undefined {
  let value = address.toLowerCase().split('%')[0] ?? '';
  if (!value.includes(':')) return undefined;
  const lastColon = value.lastIndexOf(':');
  const dotted = value.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part > 255)) {
      return undefined;
    }
    const firstGroup = (((octets[0] as number) << 8) | (octets[1] as number)).toString(16);
    const secondGroup = (((octets[2] as number) << 8) | (octets[3] as number)).toString(16);
    value = `${value.slice(0, lastColon + 1)}` + `${firstGroup}:${secondGroup}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[\da-f]{1,4}$/i.test(part))) {
    return undefined;
  }
  return groups.map((part) => Number.parseInt(part, 16));
}

function blockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family !== 6) return true;
  const groups = parseIpv6(address);
  if (!groups) return true;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((groups[0] as number) >= 0xfc00 && (groups[0] as number) <= 0xfdff) return true;
  if ((groups[0] as number) >= 0xfe80 && (groups[0] as number) <= 0xfebf) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mappedIpv4 = [
      ((groups[6] as number) >> 8) & 0xff,
      (groups[6] as number) & 0xff,
      ((groups[7] as number) >> 8) & 0xff,
      (groups[7] as number) & 0xff,
    ].join('.');
    return blockedIpv4(mappedIpv4);
  }
  return false;
}

function blockedResolvedAddress(address: ResolvedAddress): string | undefined {
  if (address.family !== isIP(address.address) || blockedAddress(address.address)) {
    return `Blocked private, loopback, or reserved address: ${address.address}`;
  }
  return undefined;
}

/**
 * web_fetch sends no credentials by design, so the GitHub API answers 401/403
 * (code search always needs a token). Strata retried it blind; name the path
 * that carries the user's own `gh auth login` instead.
 */
function authHint(url: string, status: number): string {
  if (status !== 401 && status !== 403) return '';
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (host !== 'api.github.com') return '';
  return ' — web_fetch sends no credentials. Use exec_command with `gh api <path>` or `gh search code <query>`, which run under the gh login.';
}

/**
 * Validate the URL's shape before DNS resolution. Resolved addresses are
 * checked separately immediately before each connection.
 */
function ssrfCheck(url: string): string | null {
  const parsed = parseFetchUrl(url);
  return typeof parsed === 'string' ? parsed : null;
}

function defaultPinnedFetch(
  url: string,
  _address: ResolvedAddress,
  init: RequestInitWithSignal,
  agent: Agent,
): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    dispatcher: agent,
  } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

// ── HTML → plain text ─────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  // Remove script and style blocks first
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

// ── web_fetch ─────────────────────────────────────────────────────────────────

export function makeWebFetchTool(dependencies: WebFetchDependencies = {}): RegisteredTool {
  const lookup = dependencies.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }));
  const pinnedFetch = dependencies.fetch ?? defaultPinnedFetch;
  return {
    definition: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description:
          'Fetch a public web page and return its text content (HTML stripped). ' +
          'SSRF-guarded: hosts resolving to private, loopback, link-local, CGNAT or ULA addresses are rejected.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch (must be https:// or http://).' },
            max_chars: {
              type: 'integer',
              description: 'Maximum characters of content to return. Defaults to 30000.',
            },
            https_only: {
              type: 'boolean',
              description: 'Reject non-HTTPS redirect targets. Used by restricted capabilities.',
            },
            find: {
              type: 'string',
              maxLength: 200,
              description:
                'Optional case-insensitive text to find. Returns a max_chars window around its first match.',
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    permission: 'fetch',
    handler: async (args) => {
      const url = args['url'] as string;
      const maxChars = (args['max_chars'] as number | undefined) ?? 30000;
      const httpsOnly = args['https_only'] === true;
      const find = args['find'] as string | undefined;

      const blocked = ssrfCheck(url);
      if (blocked) {
        throw new ToolError(`web_fetch: ${blocked}`);
      }
      if (httpsOnly && !url.toLowerCase().startsWith('https://')) {
        throw new ToolError('web_fetch: HTTPS is required for this capability.');
      }

      let result: { response: Response; body: string };
      try {
        result = await fetchPublicPage(url, httpsOnly, lookup, pinnedFetch);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError(`web_fetch: network error — ${(err as Error).message}`);
      }
      const { response, body: html } = result;

      if (!response.ok) {
        throw new ToolError(
          `web_fetch: HTTP ${response.status} ${response.statusText}${authHint(url, response.status)}`,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      let text: string;
      if (contentType.includes('text/html')) {
        text = htmlToText(html);
      } else {
        // Plain text, JSON, etc. — strip any stray tags just in case
        text = htmlToText(html);
      }

      if (find === undefined) {
        return `<UNTRUSTED_CONTENT>\n${text.slice(0, maxChars)}\n</UNTRUSTED_CONTENT>`;
      }
      const excerpt = findWindow(text, find, maxChars);
      return `<UNTRUSTED_CONTENT>\n${excerpt.header}\n${excerpt.text}\n</UNTRUSTED_CONTENT>`;
    },
  };
}

function findWindow(
  text: string,
  find: string,
  maxChars: number,
): { header: string; text: string } {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(escaped, 'iu').exec(text);
  if (!match) {
    return {
      header: `No match for ${JSON.stringify(find)}; returned the first ${String(maxChars)} characters.`,
      text: text.slice(0, maxChars),
    };
  }
  const matchCenter = match.index + Math.floor(match[0].length / 2);
  const start = Math.max(
    0,
    Math.min(matchCenter - Math.floor(maxChars / 2), text.length - maxChars),
  );
  return {
    header: `Match offset ${String(match.index)}; total length ${String(text.length)} characters.`,
    text: text.slice(start, start + maxChars),
  };
}

async function fetchPublicPage(
  url: string,
  httpsOnly: boolean,
  lookup: (hostname: string) => Promise<ResolvedAddress[]>,
  pinnedFetch: PinnedFetch,
): Promise<{ response: Response; body: string }> {
  let currentUrl = url;
  const pins = new Map<string, ResolvedAddress>();
  const agent = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        const pin = pins.get(hostname.toLowerCase());
        if (!pin) {
          callback(new Error(`No vetted address for ${hostname}`), '', 0);
          return;
        }
        if (options.all) callback(null, [{ address: pin.address, family: pin.family }]);
        else callback(null, pin.address, pin.family);
      },
    },
  });
  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const parsed = parseFetchUrl(currentUrl);
      if (typeof parsed === 'string') {
        const prefix = hop === 0 ? '' : 'redirect target rejected — ';
        throw new ToolError(`web_fetch: ${prefix}${parsed}`);
      }
      if (httpsOnly && parsed.protocol !== 'https:') {
        throw new ToolError(
          hop === 0
            ? 'web_fetch: HTTPS is required for this capability.'
            : 'web_fetch: HTTPS is required for every redirect target.',
        );
      }
      const hostname = normalizedHostname(parsed);
      const addresses = await lookup(hostname);
      if (addresses.length === 0) {
        throw new ToolError(`web_fetch: DNS lookup returned no addresses for ${hostname}.`);
      }
      for (const address of addresses) {
        const blocked = blockedResolvedAddress(address);
        if (blocked) {
          const reason = hop > 0 ? `redirect target rejected — ${blocked}` : blocked;
          throw new ToolError(`web_fetch: ${reason}`);
        }
      }
      const pinned = addresses[0] as ResolvedAddress;
      pins.set(hostname, pinned);
      const response = await pinnedFetch(
        currentUrl,
        pinned,
        {
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { 'User-Agent': USER_AGENT },
        },
        agent,
      );
      if (response.status < 300 || response.status >= 400 || response.status === 304) {
        return { response, body: await response.text() };
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new ToolError('web_fetch: redirect had no Location header.');
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new ToolError(`web_fetch: exceeded ${MAX_REDIRECT_HOPS} redirects.`);
  } finally {
    await agent.close();
  }
}
