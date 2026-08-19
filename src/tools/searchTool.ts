import type * as vscode from 'vscode';
import type { SearchConfig } from '../config/types';
import type { RegisteredTool } from './ToolRegistry';

// ── Provider response shapes (minimal, validated at runtime) ──────────────────

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function makeWebSearchTool(
  secrets: vscode.SecretStorage,
  cfg: SearchConfig,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description: `Search the web using ${cfg.provider} and return the top results as markdown.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'search',
    handler: async (args) => {
      const query = args['query'] as string;
      const apiKey = await secrets.get(cfg.secret_key_name);
      if (!apiKey) {
        throw new Error(
          `Forge search: API key not found in SecretStorage under "${cfg.secret_key_name}". ` +
            `Run "Forge: Set Search API Key" to store it.`,
        );
      }

      const maxResults = cfg.max_results ?? 5;

      return cfg.provider === 'tavily'
        ? searchTavily(query, apiKey, maxResults)
        : searchBrave(query, apiKey, maxResults);
    },
  };
}

// ── Tavily ────────────────────────────────────────────────────────────────────

async function searchTavily(query: string, apiKey: string, maxResults: number): Promise<string> {
  // Bearer header, which is the only form Tavily documents. The older `api_key`
  // body field still works (verified against the live API 2026-08-19), so this
  // is alignment with the documented contract, not a fix for a broken call — do
  // not read a 401 here as evidence the transport is wrong. Either form returns
  // an identical 401 for a bad key, so a 401 means the KEY, and the first thing
  // to check is whether one is stored at all.
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
  });

  if (!response.ok) {
    // 401 here means the key was rejected, not that it was missing — the
    // missing case is caught before the request is ever made.
    const hint =
      response.status === 401
        ? ' — key rejected. Re-run "Forge: Set Search API Key" with a current tvly- key.'
        : '';
    throw new Error(`Tavily search failed: HTTP ${response.status}${hint}`);
  }

  const data = (await response.json()) as TavilyResponse;
  const results = data.results ?? [];
  if (!results.length) return 'No results found.';

  return results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title ?? 'Untitled'}** — <${r.url ?? ''}>\n   ${r.content?.slice(0, 300) ?? ''}`,
    )
    .join('\n\n');
}

// ── Brave ─────────────────────────────────────────────────────────────────────

async function searchBrave(query: string, apiKey: string, maxResults: number): Promise<string> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave search failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as BraveResponse;
  const results = data.web?.results ?? [];
  if (!results.length) return 'No results found.';

  return results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title ?? 'Untitled'}** — <${r.url ?? ''}>\n   ${r.description?.slice(0, 300) ?? ''}`,
    )
    .join('\n\n');
}
