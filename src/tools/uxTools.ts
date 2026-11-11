import * as path from 'path';
import { createHash } from 'crypto';
import type { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import {
  NOTIFY_IDLE_RESET_MS,
  NOTIFY_TURN_LIMIT,
  type UserNotificationService,
} from '../sidebar/UserNotificationService';
import {
  unattendedConversations,
  type UnattendedConversationRegistry,
} from '../sidebar/unattendedConversations';
import { defaultOutboxDir, writeOutboxItem } from '../jobs/JobOutbox';
import * as fs from 'fs';
import { resolveRealWorkspacePath, resolveWorkspacePath } from '../util/WorkspacePaths';
import { markdownToHtml, localMarkdownImageResolver } from '../documents/markdownToHtml';
import { writeFileAtomicSync } from '../util/atomicWrite';
import type { ForgeConfig } from '../config/types';
import { secretPatternForTaint } from './secretPaths';
import { hasConversationReadSecret, secretReadCardReason } from './exfilTaint';
import { openSystemBrowser } from './systemBrowser';
import { NET_KEY } from '../sidebar/approvalKeyGrammar';

type UnattendedOutboxWriter = (
  conversationId: string,
  jobMeta: { jobId: string; jobName: string } | undefined,
  message: string,
) => Promise<void>;

const writeUnattendedNotification: UnattendedOutboxWriter = async (
  conversationId,
  jobMeta,
  message,
) => {
  // A job run writes under the job id with the job name, so a run yields one
  // coalesced outbox item per job (AC10). A marker with no job (none today)
  // falls back to the conversation id.
  const key = jobMeta?.jobId ?? conversationId;
  const name = jobMeta?.jobName ?? `Unattended conversation ${conversationId}`;
  await writeOutboxItem(defaultOutboxDir(), key, name, message, Date.now());
};

// ── show_diff ─────────────────────────────────────────────────────────────────

export function makeShowDiffTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'show_diff',
        description:
          'Open a VS Code diff editor comparing two files, for the user to see. The result ' +
          'carries no diff text; to read the changes yourself, use git_read diff (tracked ' +
          'files) or read_file on both files.',
        parameters: {
          type: 'object',
          properties: {
            original_path: { type: 'string', description: 'Path to the original (left) file.' },
            modified_path: { type: 'string', description: 'Path to the modified (right) file.' },
            title: { type: 'string', description: 'Optional title for the diff tab.' },
          },
          required: ['original_path', 'modified_path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const uri1 = resolveWorkspaceUri(args['original_path'] as string);
      const uri2 = resolveWorkspaceUri(args['modified_path'] as string);
      const title = (args['title'] as string | undefined) ?? 'Forge Diff';
      await vscode.commands.executeCommand('vscode.diff', uri1, uri2, title);
      return 'Diff opened.';
    },
  };
}

// ── open_file ─────────────────────────────────────────────────────────────────

/** Binary extensions are opened by VS Code's native binary editor command. */
const BINARY_FILE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.tif',
  '.tiff',
  '.pdf',
  '.zip',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.mp3',
  '.wav',
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.avi',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

/**
 * Show a file in the editor.
 *
 * Forge could already open a file — `ToolDispatch.openFile` backs the webview's
 * file links and the auto-open-after-write setting — but no tool exposed it, so
 * "open config.yaml in the editor" was a request the agent had no way to
 * satisfy. It would read the file out into the chat instead, which is not what
 * was asked for. A capability the model cannot reach is one the transcript
 * cannot show is missing (CLAUDE.md, "Agent-Ergonomics Traps").
 */
export function makeOpenFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'open_file',
        description:
          'Open a file in the main VS Code editor so the user can see it. Use this ' +
          'whenever the user asks to open, show, or bring up a file — it puts the real ' +
          'editor tab in front of them, which reading the file into the chat does not. ' +
          'Does not return the contents: use read_file for that.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'File to open, relative to the workspace root or absolute. The workspace ' +
                "root is not necessarily the project root — prefix a nested repository's " +
                'directory when the file lives inside one.',
            },
            line: {
              type: 'integer',
              minimum: 1,
              description:
                'Optional 1-based line to reveal and place the cursor on; must be a positive integer.',
            },
            beside: {
              type: 'boolean',
              description:
                'Open in a column beside the active editor instead of reusing it. ' +
                'Defaults to false.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const suppliedPath = args['path'] as string;
      const uri = resolveWorkspaceUri(suppliedPath);
      if (BINARY_FILE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase())) {
        await vscode.commands.executeCommand('vscode.open', uri);
        return `Opened ${suppliedPath} in the editor.`;
      }
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch (err) {
        throw new Error(`open_file: cannot open ${suppliedPath} — ${(err as Error).message}`);
      }
      // `line` arrives 1-based from the model; VS Code positions are 0-based.
      const rawLine = args['line'] as number | undefined;
      const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
      const zeroBased =
        rawLine === undefined ? undefined : Math.min(Math.max(0, rawLine - 1), lastLine);
      const target =
        zeroBased === undefined ? undefined : new vscode.Range(zeroBased, 0, zeroBased, 0);
      await vscode.window.showTextDocument(doc, {
        // Not a preview tab: a preview is replaced by the next thing opened, so
        // the file the user asked for would vanish behind the agent's own reads.
        preview: false,
        preserveFocus: false,
        ...(args['beside'] === true ? { viewColumn: vscode.ViewColumn.Beside } : {}),
        ...(target ? { selection: target } : {}),
      });
      if (rawLine !== undefined && rawLine > doc.lineCount) {
        return `line ${rawLine} is past the end of the file (${doc.lineCount} lines); opened at line ${doc.lineCount}.`;
      }
      return zeroBased === undefined
        ? `Opened ${suppliedPath} in the editor.`
        : `Opened ${suppliedPath} in the editor at line ${zeroBased + 1}.`;
    },
  };
}

// ── notify_user ───────────────────────────────────────────────────────────────

export function makeNotifyUserTool(
  notifications: UserNotificationService,
  unattended: UnattendedConversationRegistry = unattendedConversations,
  writeOutbox: UnattendedOutboxWriter = writeUnattendedNotification,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'notify_user',
        description:
          'Ping the user -- THE tool for "ping me", "notify me", "let me know", or ' +
          '"tell me when". Reaches the VS Code window and the remote chat that started ' +
          'the turn. Fire-and-forget: does not wait for a reply (use ask_user for that).',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message shown to the user.' },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      const message = args['message'] as string;
      const conversationId = context?.conversationId;
      const isUnattended = conversationId !== undefined && unattended.has(conversationId);
      if (notifications.remaining(context?.conversationId) <= 0) {
        // Say that the budget refills, and when. The old string ended at "put
        // it in your final reply", which on a long unattended run means hours
        // from now -- correct for a runaway loop, useless for a paced report,
        // and the model cannot tell which case it is in from the cap alone.
        const waitMs = notifications.idleResetIn(context?.conversationId);
        const waitMin = Math.max(1, Math.ceil(waitMs / 60_000));
        return (
          `Notification limit reached: ${NOTIFY_TURN_LIMIT} sent in the last ` +
          `${NOTIFY_IDLE_RESET_MS / 60_000} minutes. The message was NOT sent. ` +
          `The budget refills after ${waitMin} more minute(s) without a ` +
          'notification, so a paced update will go through later in this turn. ' +
          'Do not retry now -- put this message in your final reply instead.'
        );
      }
      // The desktop toast is unconditional: it has to work with remote disabled,
      // and a user sitting at the machine should see what the phone was sent.
      void vscode.window.showInformationMessage(message);
      if (isUnattended && conversationId) {
        await writeOutbox(conversationId, unattended.jobMeta(conversationId), message);
      }
      const chats = await notifications.notify({
        text: message,
        ...(conversationId ? { conversationId } : {}),
      });
      if (isUnattended) {
        return chats > 0
          ? `Message queued to the job outbox and delivered to the VS Code window and ${chats} remote chat(s).`
          : 'Message queued to the job outbox for Telegram and shown in the VS Code window.';
      }
      // Say where it actually landed. A "sent" that means nothing left the
      // machine is how ask_user taught the model to trust a lie.
      return chats > 0
        ? `Message delivered to the VS Code window and ${chats} remote chat(s).`
        : 'Shown in the VS Code window only. No remote chat is bound to this ' +
            'conversation, so the user did NOT receive it on their phone. Do not ' +
            'claim you notified them remotely.';
    },
  };
}

// ── show_notification ─────────────────────────────────────────────────────────

type NotifLevel = 'info' | 'warning' | 'error';

export function makeShowNotificationTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'show_notification',
        description:
          'Show a notification in the VS Code window ONLY (info, warning, or error), ' +
          'invisible to a user who is away or remote. To ping the user, use notify_user.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Notification text.' },
            level: {
              type: 'string',
              enum: ['info', 'warning', 'error'],
              description: 'Severity level. Defaults to "info".',
            },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const message = args['message'] as string;
      const level = (args['level'] as NotifLevel | undefined) ?? 'info';
      if (level === 'error') {
        vscode.window.showErrorMessage(message);
      } else if (level === 'warning') {
        vscode.window.showWarningMessage(message);
      } else {
        vscode.window.showInformationMessage(message);
      }
      return 'Shown.';
    },
  };
}

// ── open_url_in_browser ───────────────────────────────────────────────────────

/**
 * Total inline image bytes a Markdown preview may carry. The PDF export path is
 * bounded by printHtmlToPdf's 2 MiB HTML cap; a preview has no such cap, so
 * without a budget of its own a Markdown file of screenshots writes a
 * hundred-megabyte HTML page that takes minutes to open. 8 MB of data URIs is
 * about 6 MB of image bytes, well past what reading a document in a browser
 * needs, and keeps the preview file small enough to open at once.
 */
const PREVIEW_IMAGE_BUDGET_BYTES = 8 * 1024 * 1024;

export function makeOpenUrlTool(
  deps: {
    getConfig?: () => ForgeConfig;
    extraRoots?: () => readonly string[];
    spawnProcess?: typeof spawn;
  } = {},
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'open_url_in_browser',
        description:
          'Open an HTTP(S) URL or a workspace HTML, PDF, or Markdown file in the default browser. Markdown is rendered into a styled preview under .forge/tmp/preview/.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description:
                'HTTP(S) URL or workspace-relative/absolute .html, .pdf, .md, or .markdown path.',
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    approval: (args, context) => {
      const url = args['url'];
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return undefined;
      const readSecret = hasConversationReadSecret(context?.conversationId);
      const host = URL.canParse(url) ? new URL(url).hostname.toLowerCase() : undefined; // else no key
      return {
        detail: url,
        dangerous: true,
        reachesOut: 'network',
        ...(!readSecret && host ? { approvalKey: `${NET_KEY}${host}` } : {}),
        ...(readSecret
          ? {
              gateKind: 'taintGate' as const,
              secretReadTaint: true,
              cardReason: secretReadCardReason(context?.conversationId),
              declineHint:
                'tell the owner what you need to open; a secret read taints the whole chat',
            }
          : {}),
      };
    },
    handler: async (args) => {
      const url = args['url'] as string;
      if (url.startsWith('https://') || url.startsWith('http://')) {
        await openSystemBrowser(url, process.platform, deps.spawnProcess);
        return `Opened ${url} in the default browser.`;
      }
      if (!/^[a-z]:[\\/]/i.test(url) && /^[a-z][a-z0-9+.-]*:/i.test(url))
        throw new Error(
          'open_url_in_browser: URL must start with http:// or https://, or be a workspace file path.',
        );
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error('open_url_in_browser: no workspace folder is open.');
      const roots = deps.extraRoots?.() ?? [];
      const secret = secretPatternForTaint(url, deps.getConfig?.(), (value) => {
        try {
          return resolveWorkspacePath(value, { workspaceRoot: root });
        } catch {
          return undefined;
        }
      });
      if (secret)
        throw new Error(
          `open_url_in_browser: path matches secret path rule ${secret}; choose a non-secret file.`,
        );
      const file = await resolveRealWorkspacePath(url, root, { extraRoots: roots });
      const extension = path.extname(file).toLowerCase();
      if (!['.html', '.pdf', '.md', '.markdown'].includes(extension))
        throw new Error(
          'open_url_in_browser: workspace paths must end in .html, .pdf, .md, or .markdown.',
        );
      let openedPath = file;
      let omittedNote = '';
      if (extension === '.md' || extension === '.markdown') {
        const stat = fs.statSync(file);
        if (stat.size > 2 * 1024 * 1024)
          throw new Error('open_url_in_browser: Markdown source exceeds the 2 MiB limit.');
        const markdown = fs.readFileSync(file, 'utf8');
        const omittedImages: string[] = [];
        const html = await markdownToHtml(markdown, {
          resolveImage: localMarkdownImageResolver(file, root, roots, deps.getConfig),
          maxImageDataUriBytes: PREVIEW_IMAGE_BUDGET_BYTES,
          omittedImageReason: 'over the preview image budget',
          omittedImages,
        });
        const previewDir = path.join(root, '.forge', 'tmp', 'preview');
        const relativeSource = path.relative(root, file).split(path.sep).join('/');
        const sourceHash = createHash('sha256').update(relativeSource).digest('hex').slice(0, 8);
        const previewName = `${path.basename(file, extension)}-${sourceHash}.html`;
        openedPath = await resolveRealWorkspacePath(path.join(previewDir, previewName), root, {
          allowMissing: true,
        });
        fs.mkdirSync(path.dirname(openedPath), { recursive: true });
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const entry of fs.readdirSync(previewDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const candidate = path.join(previewDir, entry.name);
          if (fs.statSync(candidate).mtimeMs < cutoff) fs.unlinkSync(candidate);
        }
        writeFileAtomicSync(openedPath, html);
        if (omittedImages.length)
          omittedNote = ` Left out of the preview over the image budget: ${omittedImages.join(', ')}.`;
      }
      await vscode.env.openExternal(vscode.Uri.file(openedPath));
      return `Opened ${openedPath}.${omittedNote}`;
    },
  };
}

// ── Internal helper ───────────────────────────────────────────────────────────
