/**
 * One SerpApi GET, shared by every reverse-image engine (Google Lens, Yandex).
 * Engines differ in parameters and response shape, never in transport or in
 * how SerpApi reports a failure.
 */

export const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

export type SerpApiResponse = Record<string, unknown>;

export interface SerpApiRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function serpApiGet(
  params: Record<string, string>,
  options: SerpApiRequestOptions = {},
): Promise<SerpApiResponse> {
  const query = new URLSearchParams(params);
  const response = await (options.fetchImpl ?? fetch)(`${SERPAPI_ENDPOINT}?${query}`, {
    headers: { Accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`SerpApi returned HTTP ${response.status} and no JSON: ${text.slice(0, 200)}`);
  }
  // SerpApi puts the reason in `error` for both 4xx (bad key: 401) and quota
  // exhaustion; surface it verbatim — it names the fix.
  const error = isRecord(data) && typeof data['error'] === 'string' ? data['error'] : undefined;
  if (error) throw new Error(`SerpApi: ${error}`);
  if (!response.ok || !isRecord(data)) {
    throw new Error(`SerpApi search failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }
  return data;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function httpsUrl(value: unknown): string | undefined {
  const url = str(value);
  return /^https:\/\/\S+$/u.test(url) ? url : undefined;
}
