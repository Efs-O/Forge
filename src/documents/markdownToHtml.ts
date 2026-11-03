import { marked, Renderer } from 'marked';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { secretPatternForTaint } from '../tools/secretPaths';
import type { ForgeConfig } from '../config/types';

export interface MarkdownHtmlOptions {
  resolveImage?: (href: string) => Promise<string | undefined>;
  maxImageDataUriBytes?: number;
  omittedImages?: string[];
  /**
   * Why an image cut by the budget reads as left out, in the page itself. It
   * defaults to the PDF print case, which is what the 512 KB budget was for; a
   * preview has its own budget and says so.
   */
  omittedImageReason?: string;
}

export function localMarkdownImageResolver(
  markdownPath: string,
  workspaceRoot: string,
  extraRoots: readonly string[],
  getConfig?: () => ForgeConfig,
): (href: string) => Promise<string | undefined> {
  const mimeByExtension: Readonly<Record<string, string>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
  };
  return async (href) => {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('\\'))
      return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? href);
    } catch {
      return undefined;
    }
    const extension = path.extname(decoded).toLowerCase();
    const mime = mimeByExtension[extension];
    if (!mime) return undefined;
    try {
      const file = await resolveRealWorkspacePath(
        path.resolve(path.dirname(markdownPath), decoded),
        workspaceRoot,
        { extraRoots: [...extraRoots, path.dirname(markdownPath)] },
      );
      if (
        secretPatternForTaint(file, getConfig?.(), (value) =>
          resolveWorkspacePath(value, { workspaceRoot }),
        )
      )
        return undefined;
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return undefined;
      const bytes = await fs.readFile(file);
      return `data:${mime};base64,${bytes.toString('base64')}`;
    } catch {
      return undefined;
    }
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeLink(href: string): string | undefined {
  try {
    const url = new URL(href, 'https://forge.invalid/');
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

export async function markdownToHtml(
  markdown: string,
  options: MarkdownHtmlOptions = {},
): Promise<string> {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = ({ href, title, text }) => {
    const safe = safeLink(href);
    return safe
      ? `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</a>`
      : text;
  };
  renderer.image = ({ href, title, text }) =>
    `<img data-forge-image="${escapeHtml(href)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
  const body = await marked.parse(markdown, { async: true, gfm: true, breaks: false, renderer });
  const withImages = await replaceImages(body, options);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{font:16px/1.6 system-ui,sans-serif;max-width:860px;margin:48px auto;padding:0 28px;color:#20242b}h1,h2,h3{line-height:1.25;margin-top:1.6em}table{border-collapse:collapse;width:100%;margin:1.2em 0}th,td{border:1px solid #cbd2da;padding:8px 12px;text-align:left}th{background:#f2f4f7}pre{overflow:auto;padding:14px;background:#f2f4f7;border-radius:6px}blockquote{border-left:4px solid #9aa8b7;margin-left:0;padding-left:16px;color:#58616c}img{max-width:100%;height:auto}
</style></head><body>${withImages}</body></html>`;
}

async function replaceImages(html: string, options: MarkdownHtmlOptions): Promise<string> {
  const pattern = /<img data-forge-image="([^"]*)" alt="([^"]*)"([^>]*)>/g;
  const matches = [...html.matchAll(pattern)];
  const chunks: string[] = [];
  let cursor = 0;
  let imageBytes = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    chunks.push(html.slice(cursor, index));
    const href = decodeEntities(match[1] ?? '');
    const alt = match[2] ?? '';
    let source = options.resolveImage ? await options.resolveImage(href) : undefined;
    const sourceBytes = source?.startsWith('data:') ? Buffer.byteLength(source, 'utf8') : 0;
    if (
      source &&
      options.maxImageDataUriBytes !== undefined &&
      imageBytes + sourceBytes > options.maxImageDataUriBytes
    ) {
      source = undefined;
      const name = path.basename(href.split(/[?#]/, 1)[0] ?? href) || href;
      options.omittedImages?.push(name);
      const reason = options.omittedImageReason ?? 'too large for PDF export';
      chunks.push(
        `<span class="missing-image">image omitted: ${escapeHtml(name)} (${reason})</span>`,
      );
    } else if (source) {
      imageBytes += sourceBytes;
      chunks.push(`<img src="${escapeHtml(source)}" alt="${alt}"${match[3] ?? ''}>`);
    } else {
      chunks.push(`<span class="missing-image">${alt || 'Image omitted'}</span>`);
    }
    cursor = index + match[0].length;
  }
  chunks.push(html.slice(cursor));
  return chunks.join('');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
