import { lookup as dnsLookup } from 'dns/promises';
import type { RegisteredTool } from './ToolRegistry';
import { ToolApprovalRefusal } from './toolContract';
import { htmlToText } from '../util/htmlText';
import { defuseMarkers } from './untrustedText';
import { readTextCapped } from '../util/readTextCapped';
import {
  allowedHostsFor,
  fetchApprovalFor,
  hostMatchesList,
  isHostApproved,
  markHostApproved,
  normalizedHostname,
  redirectGate,
} from './fetchHostApprovals';
import {
  MAX_REDIRECT_HOPS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  ToolError,
  blockedResolvedAddress,
  createPinnedAgent,
  defaultPinnedFetch,
  parseFetchUrl,
  ssrfCheck,
  type PinnedFetch,
  type ResolvedAddress,
  type WebFetchDependencies,
} from './webFetchSsrf';
export {
  MAX_REDIRECT_HOPS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  ToolError,
  blockedResolvedAddress,
  defaultPinnedFetch,
  parseFetchUrl,
  ssrfCheck,
} from './webFetchSsrf';
export type { ResolvedAddress, WebFetchDependencies } from './webFetchSsrf';
const DEFAULT_MAX_CHARS = 30_000;
export const MAX_MAX_CHARS = 100_000;
// Caps the raw body, before HTML is reduced to text: markup is often most of a
// page, so a long docs page or thread runs 0.5-2 MB for well under MAX_MAX_CHARS
// of text, and `find` must still reach its end. Bounds memory without cutting those.
export const MAX_WEB_FETCH_BYTES = 5 * 1024 * 1024;

/**
 * web_fetch sends no credentials by design, so the GitHub API answers 401/403
 * (code search always needs a token). Strata retried it blind; name the path
 * that carries the user's own `gh auth login` instead.
 */
/**
 * A 404 is the one HTTP failure the model can act on, and the status line does
 * not say how. Measured 2026-11-21 in session 4a27df97-86d2-446d-b9ad-c3462cbcb693:
 * after web_search had found the repository, the model assembled documentation
 * paths itself (`/en/guide/getting-started`, `/sitemap.xml`,
 * `contents/website/src`, `docs/user/guide/quickstart.md`) and five of them
 * 404'd, each a whole round. Naming the way forward is what stops the next
 * guess being another spelling of the same path.
 */
const NOT_FOUND_HINT =
  ' — if you built this path yourself, do not try another spelling: web_search the page ' +
  'title, or fetch the site root and follow a link from there.';

function authHint(url: string, status: number): string {
  if (status !== 401 && status !== 403) return '';
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (host !== 'api.github.com') return '';
  return ' — web_fetch sends no credentials. Use shell with `gh api <path>` or `gh search code <query>`, which run under the gh login.';
}

// ── web_fetch ─────────────────────────────────────────────────────────────────

export function makeWebFetchTool(dependencies: WebFetchDependencies = {}): RegisteredTool {
  const lookup = dependencies.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }));
  const pinnedFetch = dependencies.fetch ?? defaultPinnedFetch;
  const approvalFor = (args: Record<string, unknown>, context?: { conversationId?: string }) =>
    fetchApprovalFor(
      typeof args['url'] === 'string' ? args['url'] : '',
      dependencies.getConfig?.(),
      context?.conversationId,
    );
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
              minimum: 1,
              maximum: MAX_MAX_CHARS,
              description: 'Maximum characters of content to return. Defaults to 30000.',
            },
            https_only: {
              type: 'boolean',
              description:
                'Leave unset. When true, a redirect to a non-HTTPS URL is refused; set internally by remote-facing fetches.',
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
    refuseBeforeApproval: (args) => {
      const url = args['url'];
      if (typeof url !== 'string') return undefined;
      const parsed = parseFetchUrl(url);
      return typeof parsed === 'string' &&
        parsed.startsWith('Blocked: raw IP address not permitted:')
        ? `Error: web_fetch: ${parsed}`
        : undefined;
    },
    /** The page's text is content this chat did not choose, and a model can be
     *  told what to do by the text it is reading. `ToolDispatch` marks the chat
     *  from this declaration after the handler runs, and `AgentLoop` asks the same
     *  question of the transcript when the stored flag goes missing — see
     *  `src/tools/exfilTaint.ts`. */
    untrustedResult: true,
    approval: approvalFor,
    handler: async (args, context) => {
      const url = args['url'] as string;
      const requestedMaxChars = args['max_chars'];
      if (
        requestedMaxChars !== undefined &&
        (typeof requestedMaxChars !== 'number' ||
          !Number.isInteger(requestedMaxChars) ||
          requestedMaxChars < 1 ||
          requestedMaxChars > MAX_MAX_CHARS)
      ) {
        throw new ToolError(
          `web_fetch: max_chars must be an integer from 1 to ${MAX_MAX_CHARS}; received ${String(requestedMaxChars)}.`,
        );
      }
      const maxChars = (requestedMaxChars as number | undefined) ?? DEFAULT_MAX_CHARS;
      const httpsOnly = args['https_only'] === true;
      const find = args['find'] as string | undefined;

      const blocked = ssrfCheck(url);
      if (blocked) {
        throw new ToolError(`web_fetch: ${blocked}`);
      }
      if (httpsOnly && !url.toLowerCase().startsWith('https://')) {
        throw new ToolError('web_fetch: HTTPS is required for this capability.');
      }
      // The host gate is per chat: one answered card covers the rest of this
      // chat and nothing else. Both flags are read before the host is marked, so
      // the note below says what the user actually approved, and an autonomous
      // run that auto-approved the call gets the same note instead of a card.
      const target = new URL(url);
      const host = normalizedHostname(target);
      const preApproved = hostMatchesList(host, allowedHostsFor(dependencies.getConfig?.()));
      const alreadyApproved = isHostApproved(context?.conversationId, host);
      markHostApproved(context?.conversationId, host);
      // A host the owner put in `fetch.allowed_hosts`, or one this chat already
      // approved, needs no note: the note exists to tell the model that a card
      // was answered for this host and that later fetches to it are free.
      const hostNote =
        preApproved || alreadyApproved
          ? ''
          : `[host ${host} was new to this chat; approved for the rest of it]\n`;

      let result: { response: Response; body: string; bytesRead: number; truncated: boolean };
      try {
        const checkRedirectHost = redirectGate(dependencies.getConfig?.(), context?.conversationId);
        result = await fetchPublicPage(
          url,
          httpsOnly,
          lookup,
          pinnedFetch,
          MAX_WEB_FETCH_BYTES,
          context?.abortSignal,
          async (redirectTarget) => {
            const refusal =
              normalizedHostname(redirectTarget) === host
                ? undefined
                : checkRedirectHost(redirectTarget);
            if (!refusal) return undefined;
            if (!context?.authorizeFetchRedirect) return refusal;
            await context.authorizeFetchRedirect(redirectTarget.toString());
            markHostApproved(context.conversationId, normalizedHostname(redirectTarget));
            return undefined;
          },
        );
      } catch (err) {
        if (err instanceof ToolError || err instanceof ToolApprovalRefusal) throw err;
        throw new ToolError(`web_fetch: network error — ${(err as Error).message}`);
      }
      const { response, body: html, bytesRead, truncated } = result;
      const cutNotice = truncated ? `\n[body cut at ${String(bytesRead)} bytes]` : '';

      if (!response.ok) {
        throw new ToolError(
          `web_fetch: HTTP ${String(response.status)}${statusTextNote(response.statusText)}${
            response.status === 404 ? NOT_FOUND_HINT : ''
          }${authHint(url, response.status)}`,
        );
      }

      // Plain text and JSON go through the same pass: stray tags are stripped
      // whatever the content type claims. Decoding entities can rebuild the
      // wrapper's closing tag from `&lt;/UNTRUSTED_CONTENT&gt;`, so the marker
      // is defused after decoding, or a page could step outside its fence.
      const text = defuseMarkers(htmlToText(html));

      if (find === undefined) {
        // Say when the page was cut, or the model takes the first window for the whole page.
        const more =
          text.length > maxChars
            ? `\n[showing ${String(maxChars)} of ${String(text.length)} characters; pass find to jump to a phrase]`
            : '';
        return `${hostNote}<UNTRUSTED_CONTENT>\n${text.slice(0, maxChars)}${more}${cutNotice}\n</UNTRUSTED_CONTENT>`;
      }
      const excerpt = findWindow(text, find, maxChars);
      return `${hostNote}<UNTRUSTED_CONTENT>\n${excerpt.header}${cutNotice}\n${excerpt.text}\n</UNTRUSTED_CONTENT>`;
    },
  };
}

/**
 * The status text is whatever the server chose to write on its status line, and
 * an error message is not fenced. Keep it short, on one line, and with the
 * untrusted-content markers defused, so a server cannot put a long hostile
 * string — or a block of its own — into Forge's words.
 */
function statusTextNote(statusText: string): string {
  const clean = defuseMarkers(statusText).replace(/\s+/gu, ' ').trim().slice(0, 64);
  return clean ? ` ${clean}` : '';
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
      // The caller's phrase is echoed back INSIDE the fence, so a closing
      // marker in it would end the block early and everything after it would
      // read as Forge's own words. The search itself uses the phrase as given.
      header: `No match for ${JSON.stringify(defuseMarkers(find))}; returned the first ${String(
        maxChars,
      )} characters.`,
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
  maxBytes: number,
  signal?: AbortSignal,
  hostGate?: (url: URL) => Promise<string | undefined>,
): Promise<{ response: Response; body: string; bytesRead: number; truncated: boolean }> {
  let currentUrl = url;
  const pins = new Map<string, ResolvedAddress[]>();
  const agent = createPinnedAgent(pins);
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
      // dns.lookup cannot be cancelled; a turn stopped meanwhile ends here (U15-06).
      signal?.throwIfAborted();
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
      // The agent is pinned to every vetted address, not just `pinned`, so a
      // blackholed DNS answer cannot hang the hop while a live one sits unused.
      pins.set(hostname, addresses);
      const response = await pinnedFetch(
        currentUrl,
        pinned,
        {
          redirect: 'manual',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT },
        },
        agent,
      );
      if (response.status < 300 || response.status >= 400 || response.status === 304) {
        const body = await readTextCapped(response, maxBytes);
        return {
          response,
          body: body.text,
          bytesRead: body.bytesRead,
          truncated: body.truncated,
        };
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new ToolError('web_fetch: redirect had no Location header.');
      const redirectTarget = new URL(location, currentUrl);
      const targetShape = parseFetchUrl(redirectTarget.toString());
      if (typeof targetShape === 'string') {
        throw new ToolError(`web_fetch: redirect target rejected — ${targetShape}`);
      }
      // An open redirect on an approved host would otherwise launder the request
      // to any host on the internet under a card the user answered for this one
      // (docs/plans/EXFIL_GATES_PLAN.md example 5), so an unapproved target asks
      // through ToolDispatch before its DNS lookup or connection.
      const notApproved = await hostGate?.(redirectTarget);
      if (notApproved) throw new ToolError(`web_fetch: ${notApproved}`);
      currentUrl = redirectTarget.toString();
    }
    throw new ToolError(`web_fetch: exceeded ${MAX_REDIRECT_HOPS} redirects.`);
  } finally {
    await agent.close();
  }
}
