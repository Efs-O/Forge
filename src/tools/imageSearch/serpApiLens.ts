/**
 * SerpApi's Google Lens engine: a public image URL in, parsed matches out.
 * Every response field is treated as optional — SerpApi's shape varies by
 * `type`, and a missing field must drop a detail, not the whole result.
 *
 * Shapes measured live 2026-09-15: `exact_matches` returns only that array;
 * `all` returns `visual_matches`, `organic_results`, `related_content` (what
 * the image shows, e.g. "Eiffel Tower"), `short_videos` and `ai_overview`.
 */

import type { ThumbnailCandidate } from './imageThumbnails';
import {
  httpsUrl,
  isRecord,
  serpApiGet,
  str,
  type SerpApiRequestOptions,
  type SerpApiResponse,
} from './serpApi';

export const LENS_SEARCH_TYPES = ['all', 'exact_matches', 'visual_matches', 'products'] as const;
export type LensSearchType = (typeof LENS_SEARCH_TYPES)[number];

/** Result arrays rendered, in this order. Anything else (videos, AI overview) is dropped. */
const LENS_SECTIONS = [
  ['exact_matches', 'Exact matches (same image)'],
  ['organic_results', 'Web pages about it'],
  ['visual_matches', 'Visually similar'],
  ['products', 'Products'],
] as const;

/**
 * Thumbnail order differs from text order: `organic_results` thumbnails are
 * 92×92 favicon-sized squares, while match thumbnails are ~170×300 (measured).
 */
const THUMBNAIL_SECTIONS = ['exact_matches', 'visual_matches', 'products', 'organic_results'];

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

export interface LensSearchRequest extends SerpApiRequestOptions {
  imageUrl: string;
  type: LensSearchType;
  apiKey: string;
}

export async function searchLens(request: LensSearchRequest): Promise<SerpApiResponse> {
  const params: Record<string, string> = {
    engine: 'google_lens',
    url: request.imageUrl,
    api_key: request.apiKey,
  };
  // `all` is SerpApi's default; sending it explicitly would change the cache key
  // for nothing.
  if (request.type !== 'all') params['type'] = request.type;
  return serpApiGet(params, request);
}

/** Trimmed, model-facing text. Never includes thumbnails or metadata. */
export function formatLensResults(
  data: SerpApiResponse,
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
  return capResultText(lines.join('\n').trim());
}

/** Largest thumbnails first; `original` is the full image, else the page. */
export function lensThumbnailCandidates(data: SerpApiResponse): ThumbnailCandidate[] {
  const candidates: ThumbnailCandidate[] = [];
  for (const key of THUMBNAIL_SECTIONS) {
    const matches = data[key];
    if (!Array.isArray(matches)) continue;
    for (const match of matches) {
      if (!isRecord(match)) continue;
      const url = httpsUrl(match['thumbnail']);
      if (!url) continue;
      const original = httpsUrl(match['image']) ?? httpsUrl(match['link']);
      candidates.push({
        url,
        title: str(match['title']).slice(0, TITLE_CHARS) || 'Untitled',
        source: str(match['source']),
        link: str(match['link']),
        ...(original ? { original } : {}),
      });
    }
  }
  return candidates;
}

export function capResultText(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (trimmed to ${MAX_RESULT_CHARS} characters)`
    : text;
}

function identifiedAs(data: SerpApiResponse): string[] {
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

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
