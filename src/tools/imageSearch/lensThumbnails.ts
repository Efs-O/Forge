import * as fs from 'fs/promises';
import * as path from 'path';
import { mimeFromHeader } from '../imageTool';
import { LENS_SECTIONS, type LensResponse } from './serpApiLens';

/**
 * Saves the top Lens match thumbnails into the workspace so the sidebar can
 * show them (workspace files are already a webview resource root, as for
 * `generate_image`) and a remote chat can receive them as photos.
 *
 * Downloaded rather than hot-linked: the webview CSP stays closed to remote
 * images, and a restored session still has the files after SerpApi's links
 * expire. Measured 2026-09-15: 1.5-7 KB JPEGs, keyless, under 0.7 s each.
 */

/** Workspace-relative; `.forge/` already holds Forge's remote inbox. */
export const THUMBNAIL_DIR = '.forge/image-search';
/** Searches older than this lose their thumbnails on the next search. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_THUMBNAIL_BYTES = 512 * 1024;
const TITLE_CHARS = 100;

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
};

export interface LensThumbnail {
  url: string;
  title: string;
  source: string;
  link: string;
}

export interface SavedThumbnail extends LensThumbnail {
  /** Workspace-relative, `/`-separated. */
  relativePath: string;
  absolutePath: string;
}

export interface ThumbnailDownload {
  saved: SavedThumbnail[];
  /** One reason per thumbnail that was picked but not saved. */
  failures: string[];
}

/**
 * First `limit` matches with a thumbnail, in the order the result text lists
 * them. Only SerpApi's and Google's own thumbnail hosts are fetched: a match's
 * page or full-size image would announce the user's IP to an arbitrary site.
 */
export function pickThumbnails(data: LensResponse, limit: number): LensThumbnail[] {
  const picked: LensThumbnail[] = [];
  for (const [key] of LENS_SECTIONS) {
    const matches = data[key];
    if (!Array.isArray(matches)) continue;
    for (const match of matches) {
      if (picked.length >= limit) return picked;
      if (typeof match !== 'object' || match === null) continue;
      const record = match as Record<string, unknown>;
      const url = typeof record['thumbnail'] === 'string' ? record['thumbnail'] : '';
      if (!isThumbnailHost(url)) continue;
      picked.push({
        url,
        title: text(record['title']).slice(0, TITLE_CHARS) || 'Untitled',
        source: text(record['source']),
        link: text(record['link']),
      });
    }
  }
  return picked;
}

export function isThumbnailHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'serpapi.com' || parsed.hostname.endsWith('.gstatic.com'))
    );
  } catch {
    return false;
  }
}

export async function downloadThumbnails(
  thumbnails: readonly LensThumbnail[],
  workspaceRoot: string,
  options: { stamp: number; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<ThumbnailDownload> {
  const base = path.join(workspaceRoot, ...THUMBNAIL_DIR.split('/'));
  await pruneOld(base, options.stamp);
  const folder = `${THUMBNAIL_DIR}/${options.stamp}`;
  await fs.mkdir(path.join(workspaceRoot, ...folder.split('/')), { recursive: true });

  const results = await Promise.all(
    thumbnails.map(async (thumbnail, index): Promise<SavedThumbnail | string> => {
      try {
        const response = await (options.fetchImpl ?? fetch)(thumbnail.url, {
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok) return `#${index + 1}: HTTP ${response.status}`;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_THUMBNAIL_BYTES) return `#${index + 1}: too large`;
        const mime = mimeFromHeader(bytes);
        if (!mime) return `#${index + 1}: not an image`;
        const relativePath = `${folder}/${index + 1}${EXTENSION_BY_MIME[mime] ?? '.img'}`;
        const absolutePath = path.join(workspaceRoot, ...relativePath.split('/'));
        await fs.writeFile(absolutePath, bytes);
        return { ...thumbnail, relativePath, absolutePath };
      } catch (err) {
        // The search's own abort must still end the turn, not become a footnote.
        if (options.signal?.aborted) throw err;
        return `#${index + 1}: ${(err as Error).message}`;
      }
    }),
  );
  return {
    saved: results.filter((r): r is SavedThumbnail => typeof r !== 'string'),
    failures: results.filter((r): r is string => typeof r === 'string'),
  };
}

/**
 * Drops search folders past retention. Best-effort, as ChatAttachmentStore's
 * prune: a leftover folder costs a few KB, while a throw here would fail a
 * search that already spent quota.
 */
async function pruneOld(base: string, now: number): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return; // first search: the folder does not exist yet
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .filter((entry) => now - Number(entry.name) > RETAIN_MS)
      .map((entry) =>
        fs.rm(path.join(base, entry.name), { recursive: true, force: true }).catch(() => undefined),
      ),
  );
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
