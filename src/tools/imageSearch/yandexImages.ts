/**
 * SerpApi's Yandex Images engine in reverse mode (`url`), same key and quota
 * as Google Lens.
 *
 * Measured live 2026-09-15 on the Eiffel test photo: 4.3 s (Lens: 18-52 s),
 * 162 KB. Sections: `image_results` (108 pages carrying the image — mostly
 * Pinterest), `similar_images` (40, thumbnail + Yandex link, no titles),
 * `image_sizes` (other copies by size — the largest was 2900×5367, the best
 * lead to an original), `image_tags` (what it shows, several languages).
 */

import type { ThumbnailCandidate } from './imageThumbnails';
import { capResultText } from './serpApiLens';
import {
  httpsUrl,
  isRecord,
  serpApiGet,
  str,
  type SerpApiRequestOptions,
  type SerpApiResponse,
} from './serpApi';

const TITLE_CHARS = 100;
const LARGEST_COPIES = 3;

export interface YandexSearchRequest extends SerpApiRequestOptions {
  imageUrl: string;
  apiKey: string;
}

export async function searchYandex(request: YandexSearchRequest): Promise<SerpApiResponse> {
  return serpApiGet(
    { engine: 'yandex_images', url: request.imageUrl, api_key: request.apiKey },
    request,
  );
}

export function formatYandexResults(data: SerpApiResponse, maxResults: number): string {
  const lines: string[] = [];
  const tags = records(data['image_tags'])
    .map((tag) => str(tag['text']))
    .filter(Boolean)
    .slice(0, 3);
  if (tags.length) lines.push(`Yandex identifies it as: ${tags.join('; ')}`);

  const copies = largestCopies(data['image_sizes']);
  if (copies.length) {
    lines.push('', 'Largest copies of this image (best lead to the original):');
    copies.forEach((copy, index) => lines.push(`${index + 1}. ${copy.size} — <${copy.link}>`));
  }

  const pages = records(data['image_results']);
  if (pages.length) {
    const shown = pages.slice(0, maxResults);
    lines.push('', `Pages with this image: ${pages.length} found, top ${shown.length} shown.`);
    shown.forEach((page, index) => {
      const title = str(page['title']) || 'Untitled';
      const parts = [
        `${index + 1}. ${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS)}…` : title}`,
      ];
      const source = str(page['source']);
      if (source) parts.push(source);
      const link = withoutTracking(str(page['link']));
      if (link) parts.push(`<${link}>`);
      lines.push(parts.join(' — '));
    });
  }

  const similar = records(data['similar_images']);
  if (similar.length) {
    lines.push('', `Visually similar: ${similar.length} images (thumbnails only, no titles).`);
  }

  if (!lines.length) return 'Yandex found no matches for this image.';
  return capResultText(lines.join('\n').trim());
}

/**
 * Page thumbnails first (they carry titles), then similar images. Yandex caps
 * its thumbnails with `w`/`h`; dropping them returns ~173×320 instead of 97×180.
 */
export function yandexThumbnailCandidates(data: SerpApiResponse): ThumbnailCandidate[] {
  const candidates: ThumbnailCandidate[] = [];
  for (const page of records(data['image_results'])) {
    const thumbnail = isRecord(page['thumbnail']) ? httpsUrl(page['thumbnail']['link']) : undefined;
    if (!thumbnail) continue;
    const original =
      (isRecord(page['original_image']) ? httpsUrl(page['original_image']['link']) : undefined) ??
      httpsUrl(page['link']);
    candidates.push({
      url: uncapped(thumbnail),
      title: str(page['title']).slice(0, TITLE_CHARS) || 'Untitled',
      source: str(page['source']),
      link: withoutTracking(str(page['link'])),
      ...(original ? { original } : {}),
    });
  }
  for (const item of records(data['similar_images'])) {
    const thumbnail = isRecord(item['image']) ? httpsUrl(item['image']['link']) : undefined;
    if (!thumbnail) continue;
    const link = httpsUrl(item['link']);
    candidates.push({
      url: uncapped(thumbnail),
      title: 'Visually similar (Yandex)',
      source: 'Yandex',
      link: link ?? '',
      ...(link ? { original: link } : {}),
    });
  }
  return candidates;
}

function largestCopies(sizes: unknown): { size: string; link: string }[] {
  if (!isRecord(sizes)) return [];
  return records(sizes['large'])
    .map((entry) => ({
      size: str(entry['size']),
      link: withoutTracking(httpsUrl(entry['link']) ?? ''),
    }))
    .filter((entry) => entry.size && entry.link)
    .slice(0, LARGEST_COPIES);
}

/**
 * Yandex tags every link `utm_source=yandexsmartcamera` and friends; on the live
 * run that tracking alone pushed the page list past the result cap.
 */
function withoutTracking(url: string): string {
  if (!url.includes('utm_')) return url;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith('utm_')) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function uncapped(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('w');
    parsed.searchParams.delete('h');
    return parsed.toString();
  } catch {
    return url;
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
