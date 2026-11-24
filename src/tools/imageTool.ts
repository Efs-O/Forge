import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ContentPart } from '../llm/types';
import { isPathInside } from '../util/pathContainment';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import type { MultimodalToolResult, RegisteredTool } from './ToolRegistry';
import type { ForgeConfig } from '../config/types';
import { MAX_PDF_BYTES } from '../documents/pdfRenderer';

/** Keep tool-loaded images within the same practical envelope as UI uploads. */
export const MAX_VIEW_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** What each supported type is called, in the words the model already sees. */
const IMAGE_KIND_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
  'image/webp': 'WebP',
};

/** The extension to rename to, for the type the bytes actually are. */
const SUGGESTED_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
};

function kind(mime: string): string {
  return IMAGE_KIND_BY_MIME[mime] ?? mime;
}

/**
 * Image type from magic bytes. Exported because `read_file` needs the same
 * answer to tell the model an image belongs to `view_image` — two sniffers
 * would drift.
 */
export function mimeFromHeader(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('view_image: no workspace folder is open.');
  return root;
}

/** How many names a missing-file refusal lists. */
export const MISSING_FOLDER_LISTING = 15;

/**
 * A missing file used to reach the model as Node's own error:
 * `Error: ENOENT: no such file or directory, realpath 'C:\Users\...'` — neither
 * the tool's name nor anything it could act on. Measured 2026-11-23 in session
 * 6de9dc67-b750-424a-8a52-26678e98d6dc.jsonl row 3153: the model had run Godot,
 * guessed where its screenshots land, and got that one line back. The refusal
 * now says which folder it did look in and what is there, so the next call is
 * the right path instead of another guess.
 */
async function missingFileMessage(requestedPath: string, candidate: string): Promise<string> {
  const parent = path.dirname(candidate);
  let entries: string[];
  try {
    entries = (await fs.readdir(parent, { withFileTypes: true })).map((entry) =>
      entry.isDirectory() ? `${entry.name}${path.sep}` : entry.name,
    );
  } catch {
    return (
      `view_image: no file at ${requestedPath}, and no folder at ${parent} either. ` +
      'Find the real path (find_files, or the shell tool) before viewing it again.'
    );
  }
  const shown = entries.slice(0, MISSING_FOLDER_LISTING).join(', ');
  if (entries.length === 0) {
    return `view_image: no file at ${requestedPath}, and ${parent} is empty.`;
  }
  const rest =
    entries.length > MISSING_FOLDER_LISTING
      ? `, … (${String(entries.length)} entries in total)`
      : '';
  return `view_image: no file at ${requestedPath}. That folder holds: ${shown}${rest}`;
}

async function resolveImagePath(requestedPath: string): Promise<{ root: string; file: string }> {
  if (!requestedPath.trim()) throw new Error('view_image: path must not be empty.');
  const root = workspaceRoot();
  // Reading is not gated to the workspace, as for read_file.
  const candidate = resolveWorkspacePath(requestedPath);
  const realFile = await fs.realpath(candidate).catch(async (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    throw new Error(await missingFileMessage(requestedPath, candidate));
  });
  const realRoot = await fs.realpath(root);
  return { root: realRoot, file: realFile };
}

/**
 * Why `view_image` is unavailable on a model without a projector. Advertised
 * nowhere and refused at dispatch — a bare "unknown tool" taught the agent the
 * capability did not exist, and it went looking for a workaround (shell `rm`
 * all over again, this time as `read_file` on a PNG).
 */
export function visionUnavailableMessage(modelName: string): string {
  return (
    `Error: view_image needs a vision model; the active model "${modelName}" is not configured ` +
    'for vision (llama.cpp: set mmproj_path; other providers: declare the vision capability). ' +
    'Do not try to read the image with another tool: ' +
    'report that you cannot see it and ask the user to switch to a vision-capable model.'
  );
}

interface RenderedPdfPage {
  page: number;
  png: Buffer;
  width: number;
  height: number;
}

export type PdfPageRenderer = (
  bytes: Buffer,
  pageNumbers: readonly number[],
  getConfig: (() => ForgeConfig) | undefined,
  abortSignal: AbortSignal | undefined,
) => Promise<RenderedPdfPage[]>;

export function makeViewImageTool(
  getConfig?: () => ForgeConfig,
  injectedPdfRenderer?: PdfPageRenderer,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'view_image',
        description:
          'Load an image or PDF page so you can see it. Needs a vision model; on a text-only model report that you cannot see it and ask the user to switch models. The path may be workspace-relative or absolute. Images: PNG, JPEG, GIF, BMP, WebP, maximum 10 MB, sent to the model exactly as they are on disk — there is no size or scale argument. For PDF, pages is optional (default 1), a page or range such as "2-4", at most 4 pages per call.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Image path, relative to the workspace root or absolute.',
            },
            pages: {
              type: 'string',
              description:
                'PDF only: 1-based page or inclusive range such as "2-4"; at most 4 pages.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    requiresVision: (name) => visionUnavailableMessage(name),
    handler: async (args, context): Promise<MultimodalToolResult> => {
      const requestedPath = args['path'];
      if (typeof requestedPath !== 'string') {
        throw new Error('view_image: path must be a string.');
      }
      const { root, file } = await resolveImagePath(requestedPath);
      const extension = path.extname(file).toLowerCase();
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error(`view_image: not a file: ${requestedPath}`);
      if (extension === '.pdf') {
        if (stat.size > MAX_PDF_BYTES)
          throw new Error(
            `view_image: PDF is too large (${stat.size.toLocaleString()} bytes; maximum ${MAX_PDF_BYTES.toLocaleString()}).`,
          );
        const pageSpec = typeof args['pages'] === 'string' ? args['pages'] : '1';
        const match = pageSpec.match(/^(\d+)(?:-(\d+))?$/);
        if (!match)
          throw new Error('view_image: pages must be a 1-based page or range such as "2-4".');
        const first = Number(match[1]);
        const last = Number(match[2] ?? match[1]);
        if (first < 1 || last < first || last - first > 3)
          throw new Error(
            'view_image: request no more than 4 PDF pages in an increasing 1-based range.',
          );
        const renderPdfPages = injectedPdfRenderer;
        if (!renderPdfPages)
          throw new Error(
            'view_image: PDF page rendering is not available in this extension session.',
          );
        const rendered = await renderPdfPages(
          await fs.readFile(file),
          Array.from({ length: last - first + 1 }, (_, i) => first + i),
          getConfig,
          context?.abortSignal,
        );
        const relative = isPathInside(root, file)
          ? path.relative(root, file) || path.basename(file)
          : file;
        const text = `Loaded PDF pages ${rendered.map((page) => page.page).join(', ')} from ${relative}.`;
        return {
          text,
          content: [
            { type: 'text', text },
            ...rendered.map((page) => ({
              type: 'image_url' as const,
              image_url: { url: `data:image/png;base64,${page.png.toString('base64')}` },
            })),
          ],
        };
      }
      if (args['pages'] !== undefined)
        throw new Error('view_image: pages is only available when path names a PDF.');
      if (stat.size > MAX_VIEW_IMAGE_BYTES) {
        throw new Error(
          `view_image: image is too large (${stat.size.toLocaleString()} bytes; maximum is ${MAX_VIEW_IMAGE_BYTES.toLocaleString()}).`,
        );
      }

      const bytes = await fs.readFile(file);
      const mime = mimeFromHeader(bytes);
      const extensionMime = IMAGE_MIME_BY_EXTENSION[extension];
      if (!mime) {
        // The 11-23 scan: a saved web page named `.png` got this same refusal
        // twice, and the model kept re-reading it. Naming the likely cause and
        // the check is cheaper than another round.
        throw new Error(
          'view_image: the file is not a PNG, JPEG, GIF, BMP or WebP image (it may be a web page ' +
            'or another format saved with an image extension). Check what it is with the shell tool ' +
            'before viewing it again.',
        );
      }
      const suggested = SUGGESTED_EXTENSION_BY_MIME[mime] ?? '.png';
      if (!extensionMime) {
        throw new Error(
          `view_image: the file is a ${kind(mime)} image but its extension ${extension || '(none)'} ` +
            `is not an image extension. Rename or copy it to ${suggested} and view that.`,
        );
      }
      if (mime !== extensionMime) {
        throw new Error(
          `view_image: the file is a ${kind(mime)} image but its extension ${extension} is for ` +
            `${kind(extensionMime)}. Rename or copy it to ${suggested} and view that.`,
        );
      }

      const relative = isPathInside(root, file)
        ? path.relative(root, file) || path.basename(file)
        : file;
      const text = `Loaded image ${relative} (${mime}, ${stat.size.toLocaleString()} bytes).`;
      const content: ContentPart[] = [
        { type: 'text', text },
        {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` },
        },
      ];
      return { text, content };
    },
  };
}
