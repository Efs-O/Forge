import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { UserNotificationService } from '../sidebar/UserNotificationService';
import { isPathInside } from '../util/pathContainment';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const PATH_REFUSAL =
  "Error: path must be in the workspace or this conversation's screenshot directory.";

export interface SendFileDeps {
  notifications: UserNotificationService;
}

async function resolveFilePath(
  requestedPath: string,
  conversationId: string | undefined,
): Promise<string | undefined> {
  try {
    return await resolveRealWorkspacePath(requestedPath);
  } catch {
    if (!conversationId) return undefined;
  }

  try {
    if (
      conversationId === 'default' ||
      conversationId === '.' ||
      conversationId === '..' ||
      /[\\/]/.test(conversationId)
    ) {
      return undefined;
    }
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
    const candidate = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(realScreenshotDir, requestedPath);
    const realCandidate = await fs.realpath(candidate);
    return isPathInside(realScreenshotDir, realCandidate) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

function refusalForSize(size: number): string {
  return (
    `Error: file is too large (${size.toLocaleString()} bytes; maximum is ` +
    `${MAX_FILE_BYTES.toLocaleString()} bytes).`
  );
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
      if (caption !== undefined && (typeof caption !== 'string' || caption.length > 1024)) {
        return 'Error: caption must be text no longer than 1024 characters.';
      }

      const absolute = await resolveFilePath(requestedPath, context?.conversationId);
      if (!absolute) return PATH_REFUSAL;

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absolute);
      } catch {
        return PATH_REFUSAL;
      }
      if (!stat.isFile()) return PATH_REFUSAL;
      if (stat.size === 0) return 'Error: cannot send an empty file.';
      if (stat.size > MAX_FILE_BYTES) return refusalForSize(stat.size);

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
