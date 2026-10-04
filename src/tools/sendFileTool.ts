import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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
    // `default` is the shared directory browserTools falls back to when a turn
    // has no conversation, so it is never a per-conversation root. Compared
    // case-insensitively: the filesystem is case-insensitive on Windows and
    // macOS, so `Default` is the same directory as `default`.
    if (
      conversationId.toLowerCase() === 'default' ||
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
    // The conversation directory must be a REAL direct child of the real base,
    // not merely inside it. Containment alone is not enough: if `conv-a` is a
    // junction pointing at `conv-b`, the resolved path is still strictly inside
    // the screenshot base, so a containment check would hand conv-b's files to
    // conv-a. Equality against the expected child path is what enforces "this
    // conversation only".
    if (realScreenshotDir !== screenshotDir) return undefined;
    const candidate = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(realScreenshotDir, requestedPath);
    const realCandidate = await fs.realpath(candidate);
    return isPathInside(realScreenshotDir, realCandidate) ? realCandidate : undefined;
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
          "Send a file from the workspace (or this conversation's screenshot directory) to the remote chat watching this turn. Use for files produced by other means: Pillow composites, browser screenshots, reports, PDFs, markdown. render_html_to_image and generate_image deliver their own output automatically — use send_file for anything else. Send only files you created or the user asked for; the copy persists on Telegram's servers, so never send credentials, keys, or config. Requires the `media` tool group to be loaded via `load_tool_group` first.",
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
      if (!absolute) return PATH_REFUSAL;

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
