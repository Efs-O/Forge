/**
 * SerpApi's Google Lens engine: one GET, a public image URL in, parsed matches
 * out. Every response field is treated as optional — SerpApi's shape varies by
 * `type`, and a missing field must drop a detail, not the whole result.
 *
 * Shapes measured live 2026-09-15: `exact_matches` returns only that array;
 * `all` returns `visual_matches`, `organic_results`, `related_content` (what
 * the image shows, e.g. "Eiffel Tower"), `short_videos` and `ai_overview`.
 */

export const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

export const LENS_SEARCH_TYPES = ['all', 'exact_matches', 'visual_matches', 'products'] as const;
export type LensSearchType = (typeof LENS_SEARCH_TYPES)[number];

/** Result arrays rendered, in this order. Anything else (videos, AI overview) is dropped. */
export const LENS_SECTIONS = [
  ['exact_matches', 'Exact matches (same image)'],
  ['organic_results', 'Web pages about it'],
  ['visual_matches', 'Visually similar'],
  ['products', 'Products'],
] as const;

const TITLE_CHARS = 100;
/** Hard ceiling on what reaches the model: ~500 tokens. */
export const MAX_RESULT_CHARS = 2_000;

interface LensMatch {
  title?: unknown;
  source?: unknown;
  link?: unknown;
  date?: unknown;
  price?: unknown;
  actual_image_width?: unknown;
  actual_image_height?: unknown;
  image_width?: unknown;
  image_height?: unknown;
}

export type LensResponse = Record<string, unknown>;

export interface LensSearchRequest {
  imageUrl: string;
  type: LensSearchType;
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function searchLens(request: LensSearchRequest): Promise<LensResponse> {
  const params = new URLSearchParams({
    engine: 'google_lens',
    url: request.imageUrl,
    api_key: request.apiKey,
  });
  // `all` is SerpApi's default; sending it explicitly would change the cache key
  // for nothing.
  if (request.type !== 'all') params.set('type', request.type);

  const response = await (request.fetchImpl ?? fetch)(`${SERPAPI_ENDPOINT}?${params}`, {
    headers: { Accept: 'application/json' },
    ...(request.signal ? { signal: request.signal } : {}),
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

/** Trimmed, model-facing text. Never includes thumbnails or metadata. */
export function formatLensResults(
  data: LensResponse,
  type: LensSearchType,
  maxResults: number,
): string {
  const lines: string[] = [];
  const identified = identifiedAs(data);
  if (identified.length) lines.push(`Google Lens identifies it as: ${identified.join('; ')}`);

  for (const [key, label] of LENS_SECTIONS) {
    const matches = data[key];
    if (!Array.isArray(matches) || matches.length === 0) continue;
    const shown = matches.slice(0, maxResults);
    lines.push('', `${label}: ${matches.length} found, top ${shown.length} shown.`);
    shown.forEach((match: LensMatch, index) => lines.push(formatMatch(match, index + 1)));
  }

  if (!lines.length) return `Google Lens (${type}) found no matches for this image.`;
  const text = lines.join('\n').trim();
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (trimmed to ${MAX_RESULT_CHARS} characters)`
    : text;
}

function identifiedAs(data: LensResponse): string[] {
  const related = data['related_content'];
  if (!Array.isArray(related)) return [];
  return related
    .map((entry) => (isRecord(entry) && typeof entry['query'] === 'string' ? entry['query'] : ''))
    .filter(Boolean)
    .slice(0, 3);
}

function formatMatch(match: LensMatch, position: number): string {
  const title = str(match.title) || 'Untitled';
  const parts = [
    `${position}. ${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS)}…` : title}`,
  ];
  const source = str(match.source);
  if (source) parts.push(source);
  const link = str(match.link);
  if (link) parts.push(`<${link}>`);
  const date = str(match.date);
  if (date) parts.push(date);
  const width = num(match.actual_image_width) ?? num(match.image_width);
  const height = num(match.actual_image_height) ?? num(match.image_height);
  if (width && height) parts.push(`${width}x${height}`);
  const price = isRecord(match.price) ? str(match.price['value']) : str(match.price);
  if (price) parts.push(price);
  return parts.join(' — ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
