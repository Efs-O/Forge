import type { RegisteredTool } from './ToolRegistry';

// ── SSRF guard ────────────────────────────────────────────────────────────────

class ToolError extends Error {}

const BLOCKED_SCHEMES = ['file://', 'data:', 'javascript:'];

/**
 * Reject private/loopback/link-local hostnames and IP ranges.
 * Returns the rejection reason, or null if the URL is acceptable.
 */
function ssrfCheck(url: string): string | null {
  for (const scheme of BLOCKED_SCHEMES) {
    if (url.toLowerCase().startsWith(scheme)) {
      return `Blocked scheme: ${scheme}`;
    }
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'Invalid URL.';
  }

  const loopback = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
  const linkLocal = '169.254.';
  if (loopback.includes(hostname)) return `Blocked loopback host: ${hostname}`;
  if (hostname.startsWith(linkLocal)) return `Blocked link-local address: ${hostname}`;

  // Private IPv4 ranges
  if (hostname.startsWith('10.')) return `Blocked private range: ${hostname}`;
  if (hostname.startsWith('192.168.')) return `Blocked private range: ${hostname}`;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return `Blocked private range: ${hostname}`;

  // Must look like a real domain (contains a dot, not pure digits/colons)
  if (!hostname.includes('.')) return `Blocked: hostname has no dot: ${hostname}`;
  if (/^[\d.:]+$/.test(hostname)) return `Blocked: raw IP address not permitted: ${hostname}`;

  return null; // OK
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

export function makeWebFetchTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description:
          'Fetch a public web page and return its text content (HTML stripped). ' +
          'SSRF-guarded: private/loopback/link-local URLs are rejected.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch (must be https:// or http://).' },
            max_chars: {
              type: 'integer',
              description: 'Maximum characters of content to return. Defaults to 30000.',
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

      const blocked = ssrfCheck(url);
      if (blocked) {
        throw new ToolError(`web_fetch: ${blocked}`);
      }

      let response: Response;
      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'User-Agent': 'Forge-VSCode-Extension/0.5 (local-llm assistant)' },
        });
      } catch (err) {
        throw new ToolError(`web_fetch: network error — ${(err as Error).message}`);
      }

      if (!response.ok) {
        throw new ToolError(`web_fetch: HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const html = await response.text();

      let text: string;
      if (contentType.includes('text/html')) {
        text = htmlToText(html);
      } else {
        // Plain text, JSON, etc. — strip any stray tags just in case
        text = htmlToText(html);
      }

      const truncated = text.slice(0, maxChars);
      return `<UNTRUSTED_CONTENT>\n${truncated}\n</UNTRUSTED_CONTENT>`;
    },
  };
}
