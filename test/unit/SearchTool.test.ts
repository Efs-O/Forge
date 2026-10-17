import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeWebSearchTool } from '../../src/tools/searchTool';
import type { SearchConfig } from '../../src/config/types';

const duckDuckGoFixture = fs.readFileSync(
  path.join(__dirname, '../fixtures/duckduckgo-search.html'),
  'utf8',
);

function secrets(values: Record<string, string> = {}): vscode.SecretStorage {
  return {
    get: vi.fn(async (key: string) => values[key]),
  } as unknown as vscode.SecretStorage;
}

function tool(config: SearchConfig, keyStore = secrets()) {
  return makeWebSearchTool(keyStore, config);
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('web_search DuckDuckGo provider', () => {
  it('parses the captured HTML, unwraps links, caps results, and skips ads', async () => {
    const htmlWithAd = duckDuckGoFixture.replace(
      '</body>',
      '<div class="result result--ad"><a class="result__a" href="https://ads.example/">Paid result</a><a class="result__snippet">Sponsored copy</a></div></body>',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse(htmlWithAd)),
    );
    const search = tool({ provider: 'duckduckgo', max_results: 3 });

    const result = await search.handler({ query: 'Forge VS Code extension' });

    expect(result).toContain('Results via DuckDuckGo');
    expect(result).toContain('**VS Code Extension | ForgeCode**');
    expect(result).toContain('<https://forgecode.dev/docs/vscode-extension/>');
    expect(result).toContain('Learn how to install and use the ForgeCode');
    expect(result).not.toContain('Paid result');
    expect(String(result).match(/^\d+\. \*\*/gm)).toHaveLength(3);
  });

  it('uses Tavily after DuckDuckGo returns zero results and labels provenance', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse('<html><body>No results</body></html>'))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ title: 'Tavily hit', url: 'https://example.com', content: 'Found it' }],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const search = tool(
      { provider: 'duckduckgo', fallback: 'tavily' },
      secrets({ 'forge.tavily.apiKey': 'tvly-test-key' }),
    );

    const result = await search.handler({ query: 'fixture query' });

    expect(result).toContain(
      'Results via Tavily (DuckDuckGo returned no results; confirmed with Tavily)',
    );
    expect(result).toContain('**Tavily hit**');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('detects a 202 anomaly page and uses the configured Brave fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse('<html><body>Anomaly detected</body></html>', 202))
      .mockResolvedValueOnce(
        jsonResponse({
          web: {
            results: [{ title: 'Brave hit', url: 'https://example.com', description: 'Snippet' }],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const search = tool(
      { provider: 'duckduckgo', fallback: 'brave' },
      secrets({ 'forge.brave.apiKey': 'brave-test-key' }),
    );

    const result = await search.handler({ query: 'fixture query' });

    expect(result).toContain('Results via Brave (DuckDuckGo was blocked; confirmed with Brave)');
    expect(result).toContain('**Brave hit**');
  });

  it('flags an unconfirmed empty result when no fallback is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('<html><body>Nothing here</body></html>')),
    );
    const result = await tool({ provider: 'duckduckgo' }).handler({ query: 'fixture query' });

    expect(result).toContain(
      'DuckDuckGo returned no results; this is NOT proof that nothing exists',
    );
    expect(result).toContain('blocked or changed its layout');
    expect(result).toContain('call web_search with provider "tavily" to confirm');
  });

  it('reports a missing fallback key without presenting DuckDuckGo emptiness as proof', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('<html><body>No results</body></html>')),
    );
    const result = await tool({ provider: 'duckduckgo', fallback: 'tavily' }).handler({
      query: 'fixture query',
    });

    expect(result).toContain('NOT proof that nothing exists');
    expect(result).toContain('Fallback Tavily was not available');
    expect(result).toContain('forge.tavily.apiKey');
  });

  it('uses the fallback after a DuckDuckGo request error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket disconnected'))
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ title: 'Tavily hit', url: 'https://example.com' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await tool(
      { provider: 'duckduckgo', fallback: 'tavily' },
      secrets({ 'forge.tavily.apiKey': 'tvly-test-key' }),
    ).handler({ query: 'fixture query' });

    expect(result).toContain(
      'Results via Tavily (DuckDuckGo failed: socket disconnected; confirmed with Tavily)',
    );
    expect(result).toContain('**Tavily hit**');
  });

  it('names both providers when both return zero results', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(htmlResponse('<html><body>No results</body></html>'))
        .mockResolvedValueOnce(jsonResponse({ results: [] })),
    );
    const result = await tool(
      { provider: 'duckduckgo', fallback: 'tavily' },
      secrets({ 'forge.tavily.apiKey': 'tvly-test-key' }),
    ).handler({ query: 'fixture query' });

    expect(result).toContain(
      'Results via Tavily (DuckDuckGo returned no results; Tavily also returned no results)',
    );
    expect(result).toContain('DuckDuckGo and Tavily both returned no results');
  });

  it('includes the fallback provider error when fallback fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(htmlResponse('<html><body>No results</body></html>'))
        .mockResolvedValueOnce(jsonResponse({}, 401)),
    );
    const result = await tool(
      { provider: 'duckduckgo', fallback: 'tavily' },
      secrets({ 'forge.tavily.apiKey': 'tvly-invalid-key' }),
    ).handler({ query: 'fixture query' });

    expect(result).toContain('Fallback Tavily failed: Tavily search failed: HTTP 401');
    expect(result).toContain('NOT proof that nothing exists');
  });

  it('lets the model override the configured provider for one call', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ web: { results: [{ title: 'Brave hit', url: 'https://example.com' }] } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const keyStore = secrets({ 'forge.brave.apiKey': 'brave-test-key' });
    const search = tool({ provider: 'duckduckgo', fallback: 'tavily' }, keyStore);

    const result = await search.handler({ query: 'fixture query', provider: 'brave' });

    expect(result).toContain('Results via Brave');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('api.search.brave.com');
    expect(keyStore.get).toHaveBeenCalledWith('forge.brave.apiKey');
  });

  it('aborts a pending DuckDuckGo request when Stop is pressed', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = tool({ provider: 'duckduckgo' }).handler({ query: 'fixture query' }, {
      abortSignal: controller.signal,
    } as Parameters<ReturnType<typeof tool>['handler']>[1]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toMatchObject({ aborted: true });
  });

  it('spaces request starts by at least one second', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        starts.push(Date.now());
        return htmlResponse(duckDuckGoFixture);
      }),
    );
    const { makeWebSearchTool } = await import('../../src/tools/searchTool');
    const search = makeWebSearchTool(secrets(), { provider: 'duckduckgo', max_results: 1 });

    await search.handler({ query: 'first' });
    const second = search.handler({ query: 'second' });
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;

    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_000);
  });
});
