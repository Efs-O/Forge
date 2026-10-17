import type * as vscode from 'vscode';
import type { SearchConfig, SearchProvider } from '../config/types';
import { sleepOrThrow } from '../util/abortableSleep';
import { readTextCapped } from '../util/readTextCapped';
import { DUCKDUCKGO_URL, extractDuckDuckGoResults } from './searchToolDuckDuckGo';
import type { DuckDuckGoOutcome, SearchResult } from './searchToolDuckDuckGo';
import type { RegisteredTool } from './ToolRegistry';

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

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DUCKDUCKGO_HTML_BYTES = 1_000_000;
const DUCKDUCKGO_PACING_MS = 1_000;
const SEARCH_PROVIDERS = ['duckduckgo', 'tavily', 'brave'] as const;

let duckDuckGoQueue = Promise.resolve();
let lastDuckDuckGoRequestAt = Number.NEGATIVE_INFINITY;

export function makeWebSearchTool(
  secrets: vscode.SecretStorage,
  cfg: SearchConfig,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description: `Search the web using ${cfg.provider}; confirm a DuckDuckGo empty result with another provider.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            provider: {
              type: 'string',
              enum: SEARCH_PROVIDERS,
              description: 'Optional provider for this search.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'search',
    handler: async (args, context) => {
      const query = args['query'] as string;
      const requestedProvider = args['provider'];
      if (
        requestedProvider !== undefined &&
        !SEARCH_PROVIDERS.includes(requestedProvider as SearchProvider)
      ) {
        throw new Error(`Unsupported web_search provider: ${String(requestedProvider)}`);
      }
      const provider = (requestedProvider as SearchProvider | undefined) ?? cfg.provider;
      // Stop cancels the request instead of leaving it running (U16-04).
      const signal = context?.abortSignal;
      const maxResults = cfg.max_results ?? 5;

      if (provider === 'duckduckgo') {
        return searchDuckDuckGoWithFallback(query, cfg, secrets, maxResults, signal);
      }

      const apiKey = await readApiKey(provider, cfg, secrets);
      return formatResults(provider, await searchApi(provider, query, apiKey, maxResults, signal));
    },
  };
}

async function searchDuckDuckGoWithFallback(
  query: string,
  cfg: SearchConfig,
  secrets: vscode.SecretStorage,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  let outcome: DuckDuckGoOutcome | undefined;
  let duckDuckGoError: string | undefined;
  try {
    outcome = await searchDuckDuckGo(query, maxResults, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    duckDuckGoError = describeError(error);
  }

  if (outcome && !outcome.blocked && outcome.results.length > 0) {
    return formatResults('duckduckgo', outcome.results);
  }

  const reason = duckDuckGoError
    ? `DuckDuckGo failed: ${duckDuckGoError}`
    : outcome?.blocked
      ? 'DuckDuckGo was blocked'
      : 'DuckDuckGo returned no results';

  if (!cfg.fallback) {
    return duckDuckGoError
      ? `Results via DuckDuckGo (request failed)\n\n${reason}. Search again with provider "tavily" or "brave" to confirm.`
      : unconfirmedEmptyResult(reason);
  }

  const fallback = cfg.fallback;
  const fallbackKeyName = secretKeyNameFor(fallback, cfg);
  let fallbackKey: string | undefined;
  try {
    fallbackKey = await secrets.get(fallbackKeyName);
  } catch (error) {
    return fallbackUnavailable(
      reason,
      fallback,
      `SecretStorage read failed: ${describeError(error)}`,
    );
  }
  if (!fallbackKey) {
    return fallbackUnavailable(
      reason,
      fallback,
      `API key not found in SecretStorage under "${fallbackKeyName}". Run "Forge: Set Search API Key" to store it.`,
    );
  }

  let fallbackResults: SearchResult[];
  try {
    fallbackResults = await searchApi(fallback, query, fallbackKey, maxResults, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    const fallbackError = `Fallback ${providerLabel(fallback)} failed: ${describeError(error)}`;
    return duckDuckGoError
      ? `Results via ${providerLabel(fallback)} (DuckDuckGo failed; fallback failed)\n\n${reason}. ${fallbackError}`
      : unconfirmedEmptyResult(reason, fallbackError);
  }

  if (fallbackResults.length > 0) {
    return formatResults(
      fallback,
      fallbackResults,
      `${reason}; confirmed with ${providerLabel(fallback)}`,
    );
  }

  if (outcome && !outcome.blocked && !duckDuckGoError) {
    return formatResults(
      fallback,
      [],
      `DuckDuckGo returned no results; ${providerLabel(fallback)} also returned no results`,
      `DuckDuckGo and ${providerLabel(fallback)} both returned no results. This is not proof that nothing exists; search results can be incomplete.`,
    );
  }

  return unconfirmedEmptyResult(reason, `${providerLabel(fallback)} also returned no results.`);
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<DuckDuckGoOutcome> {
  await waitForDuckDuckGoSlot(signal);
  const url = `${DUCKDUCKGO_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Forge web_search (DuckDuckGo HTML)',
    },
    signal: withTimeout(signal),
  });
  const body = await readTextCapped(response, MAX_DUCKDUCKGO_HTML_BYTES);
  const outcome = extractDuckDuckGoResults(body.text, maxResults);
  if (response.status === 202 || outcome.blocked) {
    return { blocked: true, results: [] };
  }
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
  }

  if (body.truncated && outcome.results.length === 0) {
    throw new Error('DuckDuckGo HTML exceeded the 1 MB response limit before results were parsed');
  }
  return outcome;
}

async function waitForDuckDuckGoSlot(signal: AbortSignal | undefined): Promise<void> {
  let releaseQueue!: () => void;
  const previous = duckDuckGoQueue;
  duckDuckGoQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;
  try {
    const delay = lastDuckDuckGoRequestAt + DUCKDUCKGO_PACING_MS - Date.now();
    if (delay > 0) {
      await sleepOrThrow(
        delay,
        signal,
        () => signal?.reason ?? new DOMException('The search was stopped.', 'AbortError'),
      );
    }
    signal?.throwIfAborted();
    lastDuckDuckGoRequestAt = Date.now();
  } finally {
    releaseQueue();
  }
}

async function searchApi(
  provider: 'tavily' | 'brave',
  query: string,
  apiKey: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  return provider === 'tavily'
    ? searchTavily(query, apiKey, maxResults, signal)
    : searchBrave(query, apiKey, maxResults, signal);
}

async function searchTavily(
  query: string,
  apiKey: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
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
    body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    signal: withTimeout(signal),
  });
  if (!response.ok) {
    const hint =
      response.status === 401
        ? ' — key rejected. Re-run "Forge: Set Search API Key" with a current tvly- key.'
        : '';
    throw new Error(`Tavily search failed: HTTP ${response.status}${hint}`);
  }
  const data = (await response.json()) as TavilyResponse;
  return (data.results ?? []).slice(0, maxResults).map((result) => ({
    title: result.title ?? 'Untitled',
    url: result.url ?? '',
    snippet: result.content?.slice(0, 300) ?? '',
  }));
}

async function searchBrave(
  query: string,
  apiKey: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal: withTimeout(signal),
  });
  if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status}`);
  const data = (await response.json()) as BraveResponse;
  return (data.web?.results ?? []).slice(0, maxResults).map((result) => ({
    title: result.title ?? 'Untitled',
    url: result.url ?? '',
    snippet: result.description?.slice(0, 300) ?? '',
  }));
}

async function readApiKey(
  provider: 'tavily' | 'brave',
  cfg: SearchConfig,
  secrets: vscode.SecretStorage,
): Promise<string> {
  const keyName = secretKeyNameFor(provider, cfg);
  const apiKey = await secrets.get(keyName);
  if (!apiKey) {
    throw new Error(
      `Forge search: API key not found in SecretStorage under "${keyName}". ` +
        'Run "Forge: Set Search API Key" to store it.',
    );
  }
  return apiKey;
}

function secretKeyNameFor(provider: 'tavily' | 'brave', cfg: SearchConfig): string {
  return provider === cfg.provider && cfg.secret_key_name
    ? cfg.secret_key_name
    : `forge.${provider}.apiKey`;
}

function formatResults(
  provider: SearchProvider,
  results: SearchResult[],
  note?: string,
  emptyMessage = 'No results found.',
): string {
  const provenance = `Results via ${providerLabel(provider)}${note ? ` (${note})` : ''}`;
  if (!results.length) return `${provenance}\n\n${emptyMessage}`;
  return `${provenance}\n\n${results
    .map(
      (result, index) =>
        `${index + 1}. **${result.title}** — <${result.url}>\n   ${result.snippet.slice(0, 300)}`,
    )
    .join('\n\n')}`;
}

function unconfirmedEmptyResult(reason: string, extra?: string): string {
  const lead = reason.startsWith('DuckDuckGo failed:')
    ? `${reason}; no fallback confirmed results.`
    : 'DuckDuckGo returned no results; this is NOT proof that nothing exists, because the page may have been blocked or changed its layout.';
  return (
    `Results via DuckDuckGo (${reason})\n\n` +
    `${lead} ` +
    'Search again with different wording, or call web_search with provider "tavily" to confirm.' +
    (extra ? ` ${extra}` : '')
  );
}

function fallbackUnavailable(reason: string, provider: 'tavily' | 'brave', detail: string): string {
  return unconfirmedEmptyResult(
    reason,
    `Fallback ${providerLabel(provider)} was not available: ${detail}`,
  );
}

function providerLabel(provider: SearchProvider): string {
  return provider === 'duckduckgo' ? 'DuckDuckGo' : provider === 'tavily' ? 'Tavily' : 'Brave';
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
