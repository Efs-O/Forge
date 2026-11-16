import * as fs from 'fs/promises';
import * as path from 'path';
import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import { Lexer, type Tokens } from 'marked';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { secretPatternForTaint } from '../tools/secretPaths';
import type { ForgeConfig } from '../config/types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Total image bytes one DOCX export may embed. The PDF path is bounded by
 * `printHtmlToPdf`'s 2 MiB HTML cap and allows 512 KB of images; a DOCX carries
 * its images inside the file with no such cap, so its budget can be larger.
 * 20 MB is what a report of screenshots actually needs, and keeps a Markdown
 * file that links a hundred of them from becoming a 200 MB export.
 */
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export interface MarkdownDocxOptions {
  /** Filled with the name of every local image the export did not embed. */
  omittedImages?: string[];
}

/** The walk's shared state: where relative image paths resolve against, how
 *  many image bytes are already in the document, and what got left out. */
interface DocxImageWalk {
  sourcePath: string;
  workspaceRoot: string;
  extraRoots: readonly string[];
  // `| undefined` is required, not style: the file compiles with
  // exactOptionalPropertyTypes, and this field is assigned an explicit
  // undefined when the caller passed no config getter.
  getConfig?: (() => ForgeConfig) | undefined;
  bytes: number;
  omittedImages?: string[];
}

const IMAGE_TYPE: Readonly<Record<string, 'jpg' | 'png' | 'gif' | 'bmp'>> = {
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.png': 'png',
  '.gif': 'gif',
  '.bmp': 'bmp',
};

export async function markdownToDocx(
  markdown: string,
  sourcePath: string,
  workspaceRoot: string,
  extraRoots: readonly string[],
  getConfig?: () => ForgeConfig,
  options: MarkdownDocxOptions = {},
): Promise<Buffer> {
  const images: DocxImageWalk = {
    sourcePath,
    workspaceRoot,
    extraRoots,
    getConfig,
    bytes: 0,
    ...(options.omittedImages ? { omittedImages: options.omittedImages } : {}),
  };
  const children: Array<Paragraph | Table> = [];
  for (const token of Lexer.lex(markdown)) {
    if (token.type === 'heading') {
      const heading = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ][Math.min(5, Math.max(0, token.depth - 1))];
      children.push(new Paragraph({ text: plainText(token.text), heading }));
    } else if (token.type === 'paragraph' || token.type === 'text') {
      const text = plainText(token.text);
      const runs: Array<TextRun | ImageRun> = text ? [new TextRun(text)] : [];
      runs.push(...(await imageRuns(token.raw, images)));
      if (runs.length) children.push(new Paragraph({ children: runs }));
    } else if (token.type === 'list') {
      for (const [index, item] of token.items.entries()) {
        const bullet = token.ordered ? `${(token.start ?? 1) + index}. ` : '• ';
        const text = plainText(item.text);
        const runs: Array<TextRun | ImageRun> = [new TextRun(bullet + text)];
        runs.push(...(await imageRuns(item.text, images)));
        children.push(new Paragraph({ children: runs, indent: { left: 360 } }));
      }
    } else if (token.type === 'table') {
      const rows = [token.header, ...token.rows].map(
        (row) =>
          new TableRow({
            children: row.map(
              (cell: Tokens.TableCell) =>
                new TableCell({ children: [new Paragraph(plainText(cell.text))] }),
            ),
          }),
      );
      children.push(new Table({ rows }));
    } else if (token.type === 'blockquote') {
      children.push(new Paragraph({ text: plainText(token.text), indent: { left: 360 } }));
    } else if (token.type === 'code') {
      children.push(
        new Paragraph({ children: [new TextRun({ text: token.text, font: 'Consolas' })] }),
      );
    }
  }
  // The walk above only sees the shapes it can embed. Anything with a
  // destination it cannot read at all is named here rather than dropped.
  omitSpaceSeparatedImages(markdown, images);
  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

/**
 * Name the Markdown images whose destination has a bare space in it —
 * `![shot](my shot.png)`. CommonMark wants that destination written in angle
 * brackets, and `imageRuns` matches only the bracketed or the space-free form,
 * so this shape is not embedded. It still has to be named: an image that
 * vanishes from a report with no word about it is the defect the owner
 * reported, and the name is the only thing that says which image was meant.
 * A URL can hold the same shape, and a URL is not a local file to go and find,
 * so it is skipped exactly as `imageRuns` skips it.
 */
function omitSpaceSeparatedImages(markdown: string, walk: DocxImageWalk): void {
  const names = walk.omittedImages;
  if (!names) return;
  const expression = /!\[[^\]]*\]\(([^)<>\n]*\s[^)<>\n]*)\)/g;
  for (const match of markdown.matchAll(expression)) {
    const destination = (match[1] ?? '')
      .trim()
      .replace(/\s+"[^"]*"$/, '')
      .trim();
    if (!destination || /^[a-z][a-z0-9+.-]*:/i.test(destination)) continue;
    names.push(path.basename(destination) || destination);
  }
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1$2')
    .replace(/^#+\s*/gm, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * The local images one Markdown block embeds, and the ones it does not.
 *
 * An image that cannot be embedded — missing, outside every root this export
 * may open, a secret path, or one that would push the document past its image
 * budget — is named and skipped, never fatal. One unreadable link used to
 * abort the whole export, so a report with a stale screenshot came out as
 * nothing at all and the model had to guess which image it was. The names go
 * back to `export_document`, which lists them in its result.
 */
async function imageRuns(markdown: string, walk: DocxImageWalk): Promise<ImageRun[]> {
  const runs: ImageRun[] = [];
  // `(<path>)` is how CommonMark writes a destination that contains a space.
  // Without this alternative `![shot](<my shot.png>)` matched nothing at all:
  // the image was neither embedded nor named in `omittedImages`, so a report
  // quietly lost a screenshot and nothing said which one. Group 2 is the
  // angle-bracket destination, group 3 the bare one, group 4 the title.
  const expression = /!\[([^\]]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"([^"]*)")?\)/g;
  for (const match of markdown.matchAll(expression)) {
    const href = match[2] ?? match[3] ?? '';
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('\\'))
      continue;
    let relative: string;
    try {
      relative = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? href);
    } catch {
      continue;
    }
    const type = IMAGE_TYPE[path.extname(relative).toLowerCase()];
    if (!type) continue;
    const name = path.basename(relative) || relative;
    try {
      const file = await resolveRealWorkspacePath(
        path.resolve(path.dirname(walk.sourcePath), relative),
        walk.workspaceRoot,
        { extraRoots: [...walk.extraRoots, path.dirname(walk.sourcePath)] },
      );
      if (
        secretPatternForTaint(file, walk.getConfig?.(), (value) =>
          resolveWorkspacePath(value, { workspaceRoot: walk.workspaceRoot }),
        )
      ) {
        walk.omittedImages?.push(name);
        continue;
      }
      const stat = await fs.stat(file);
      if (
        !stat.isFile() ||
        stat.size > MAX_IMAGE_BYTES ||
        walk.bytes + stat.size > MAX_TOTAL_IMAGE_BYTES
      ) {
        walk.omittedImages?.push(name);
        continue;
      }
      const data = await fs.readFile(file);
      walk.bytes += data.length;
      runs.push(
        new ImageRun({
          data,
          type,
          transformation: { width: 400, height: 300 },
          altText: { name: match[1] || 'image', description: match[4] || match[1] || 'image' },
        }),
      );
    } catch {
      // Missing, or outside every root this export may read: name it and carry
      // on, instead of losing the whole document to one bad link.
      walk.omittedImages?.push(name);
    }
  }
  return runs;
}
