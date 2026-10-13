import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_IMAGE_OUTPUT_DIR } from '../config/imageGenerationSchema';
import type { ForgeConfig } from '../config/types';
import type { UserNotificationService } from '../sidebar/UserNotificationService';
import { codePointLength } from '../util/codePoints';
import { fileDeliveryRefusal, inspectFileForDelivery } from '../util/fileDeliveryValidation';
import { isPathInside } from '../util/pathContainment';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';

const PATH_REFUSAL =
  "Error: path must be in the workspace or this conversation's screenshot directory.";

export interface SendFileDeps {
  notifications: UserNotificationService;
  /**
   * Optional, like render_html_to_image's: the tool is registered
   * unconditionally. Read only for `image_generation.output_dir`, so the
   * "did you mean" suggestion looks where generated images are actually saved.
   */
  getConfig?: () => ForgeConfig;
}

async function resolveFilePath(
  requestedPath: string,
  conversationId: string | undefined,
): Promise<string | undefined> {
  try {
    return await resolveRealWorkspacePath(requestedPath);
  } catch {
    return resolveScreenshotFile(requestedPath, conversationId);
  }
}

async function screenshotDirectory(
  conversationId: string | undefined,
): Promise<string | undefined> {
  if (
    !conversationId ||
    conversationId.toLowerCase() === 'default' ||
    conversationId === '.' ||
    conversationId === '..' ||
    /[\\/]/.test(conversationId)
  ) {
    return undefined;
  }
  try {
    // `default` is the shared directory browserTools falls back to when a turn
    // has no conversation, so it is never a per-conversation root. Compared
    // case-insensitively: the filesystem is case-insensitive on Windows and
    // macOS, so `Default` is the same directory as `default`.
    const screenshotBase = path.join(os.homedir(), '.forge', 'screenshots');
    const realScreenshotBase = await fs.realpath(screenshotBase);
    const screenshotDir = path.join(realScreenshotBase, conversationId);
    const realScreenshotDir = await fs.realpath(screenshotDir);
    if (
      realScreenshotDir === realScreenshotBase ||
      !isPathInside(realScreenshotBase, realScreenshotDir)
    ) {
      return undefined;
    }
    // The conversation directory must be a REAL direct child of the real base,
    // not merely inside it. Containment alone is not enough: if `conv-a` is a
    // junction pointing at `conv-b`, the resolved path is still strictly inside
    // the screenshot base, so a containment check would hand conv-b's files to
    // conv-a. Equality against the expected child path is what enforces "this
    // conversation only".
    if (realScreenshotDir !== screenshotDir) return undefined;
    return realScreenshotDir;
  } catch {
    return undefined;
  }
}

async function resolveScreenshotFile(
  requestedPath: string,
  conversationId: string | undefined,
): Promise<string | undefined> {
  const screenshotDir = await screenshotDirectory(conversationId);
  if (!screenshotDir) return undefined;
  try {
    const candidate = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(screenshotDir, requestedPath);
    const realCandidate = await fs.realpath(candidate);
    return isPathInside(screenshotDir, realCandidate) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

interface MissingWorkspaceFile {
  relativePath: string;
  suggestion?: string;
}

async function suggestExistingFile(
  basename: string,
  conversationId: string | undefined,
  imageOutputDir: string,
): Promise<string | undefined> {
  const generatedPath = path.posix.join(imageOutputDir.replace(/\\/g, '/'), basename);
  try {
    const candidate = await resolveRealWorkspacePath(generatedPath);
    if ((await fs.stat(candidate)).isFile()) return generatedPath;
  } catch {
    // A suggestion is useful only when a safe, existing regular file matches.
  }
  const screenshotDir = await screenshotDirectory(conversationId);
  if (!screenshotDir) return undefined;
  try {
    const candidate = await fs.realpath(path.join(screenshotDir, basename));
    if (isPathInside(screenshotDir, candidate) && (await fs.stat(candidate)).isFile()) {
      return candidate;
    }
  } catch {
    // No matching screenshot; the caller still gets the precise missing path.
  }
  return undefined;
}

async function missingWorkspaceFile(
  requestedPath: string,
  conversationId: string | undefined,
  imageOutputDir: string,
): Promise<MissingWorkspaceFile | undefined> {
  try {
    const candidate = await resolveRealWorkspacePath(requestedPath, undefined, {
      allowMissing: true,
    });
    try {
      await fs.stat(candidate);
      return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return undefined;
    const realRoot = await fs.realpath(root);
    const relativePath = path.relative(realRoot, candidate).split(path.sep).join('/');
    const suggestion = await suggestExistingFile(
      path.basename(candidate),
      conversationId,
      imageOutputDir,
    );
    return { relativePath, ...(suggestion ? { suggestion } : {}) };
  } catch {
    return undefined;
  }
}

export function makeSendFileTool(deps: SendFileDeps): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'send_file',
        description:
          "Send a file from the workspace (or this conversation's screenshot directory) to the remote chat watching this turn. Use for files produced by other means: Pillow composites, browser screenshots, reports, PDFs, markdown. render_html_to_image and generate_image deliver their own output automatically — use send_file for anything else. Send only files you created or the user asked for; the copy persists on Telegram's servers, so never send credentials, keys, or config.",
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              minLength: 1,
              description:
                'Workspace-relative path, or an absolute path inside this conversation’s screenshot directory.',
            },
            caption: {
              type: 'string',
              maxLength: 1024,
              description: 'Optional caption sent with the file.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'fetch',
    handler: async (args, context?: ToolHandlerContext): Promise<string> => {
      const requestedPath = args['path'];
      const caption = args['caption'];
      if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
        return PATH_REFUSAL;
      }
      // Code points, not UTF-16 code units: the schema's maxLength and
      // Telegram's caption limit are both character counts, and measuring an
      // emoji-heavy caption in code units would refuse text that fits.
      if (
        caption !== undefined &&
        (typeof caption !== 'string' || codePointLength(caption) > 1024)
      ) {
        return 'Error: caption must be text no longer than 1024 characters.';
      }

      const absolute = await resolveFilePath(requestedPath, context?.conversationId);
      if (!absolute) {
        const missing = await missingWorkspaceFile(
          requestedPath,
          context?.conversationId,
          deps.getConfig?.().image_generation?.output_dir ?? DEFAULT_IMAGE_OUTPUT_DIR,
        );
        if (!missing) return PATH_REFUSAL;
        return (
          `Error: no file at ${missing.relativePath}` +
          (missing.suggestion ? ` (did you mean ${missing.suggestion}?)` : '')
        );
      }

      const inspected = await inspectFileForDelivery(absolute);
      if (!inspected.ok) {
        if (inspected.reason === 'path') return PATH_REFUSAL;
        return `Error: ${fileDeliveryRefusal(inspected)}.`;
      }

      const result = await deps.notifications.deliverFile({
        ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
        text: caption ?? '',
        imagePath: absolute,
      });
      if (result.kind === 'refused') return result.reason;
      if (result.chats === 0) {
        return 'No remote chat is watching this turn, so nothing was queued.';
      }
      return `Queued ${path.basename(absolute)} for ${result.chats} remote chat(s).`;
    },
  };
}
