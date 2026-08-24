import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ContentPart } from '../llm/types';
import { isPathInside } from '../util/pathContainment';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import type { MultimodalToolResult, RegisteredTool } from './ToolRegistry';

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

async function resolveImagePath(requestedPath: string): Promise<{ root: string; file: string }> {
  if (!requestedPath.trim()) throw new Error('view_image: path must not be empty.');
  const root = workspaceRoot();
  const candidate = resolveWorkspacePath(requestedPath, { mustBeInsideWorkspace: true });
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  if (!isPathInside(realRoot, realFile)) {
    throw new Error(`view_image: path is outside the workspace: ${requestedPath}`);
  }
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
    `Error: view_image is not available because the active model "${modelName}" has no vision ` +
    'projector configured (mmproj_path). Do not try to read the image with another tool: ' +
    'report that you cannot see it and ask the user to switch to a vision-capable model.'
  );
}

export function makeViewImageTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'view_image',
        description:
          'Load and inspect an image file from the workspace. Use this when the user asks you to view, inspect, or describe a workspace image. The path must be workspace-relative or absolute inside the workspace. Supported formats: PNG, JPEG, GIF, BMP, and WebP. Maximum file size is 10 MB.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Image path relative to the workspace root or an absolute path inside it.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args): Promise<MultimodalToolResult> => {
      const requestedPath = args['path'];
      if (typeof requestedPath !== 'string') {
        throw new Error('view_image: path must be a string.');
      }
      const { root, file } = await resolveImagePath(requestedPath);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error(`view_image: not a file: ${requestedPath}`);
      if (stat.size > MAX_VIEW_IMAGE_BYTES) {
        throw new Error(
          `view_image: image is too large (${stat.size.toLocaleString()} bytes; maximum is ${MAX_VIEW_IMAGE_BYTES.toLocaleString()}).`,
        );
      }

      const bytes = await fs.readFile(file);
      const mime = mimeFromHeader(bytes);
      const extensionMime = IMAGE_MIME_BY_EXTENSION[path.extname(file).toLowerCase()];
      if (!mime || !extensionMime || mime !== extensionMime) {
        throw new Error(
          'view_image: unsupported image format. Use PNG, JPEG, GIF, BMP, or WebP with a matching file extension.',
        );
      }

      const relative = path.relative(root, file) || path.basename(file);
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
