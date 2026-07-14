import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';

// ── show_diff ─────────────────────────────────────────────────────────────────

export function makeShowDiffTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'show_diff',
        description: 'Open a VS Code diff editor comparing two files.',
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

// ── ask_user ──────────────────────────────────────────────────────────────────

export function makeAskUserTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_user',
        description: 'Prompt the user for input via a VS Code input box or quick-pick menu.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Question or prompt shown to the user.' },
            placeholder: {
              type: 'string',
              description: 'Placeholder text for a free-text input box.',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'If provided, shows a quick-pick list instead of a free-text box.',
            },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const prompt = args['prompt'] as string;
      const placeholder = args['placeholder'] as string | undefined;
      const options = args['options'] as string[] | undefined;

      let answer: string | undefined;
      if (options?.length) {
        answer = await vscode.window.showQuickPick(options, { placeHolder: prompt });
      } else {
        const inputOpts: vscode.InputBoxOptions = { prompt };
        if (placeholder !== undefined) inputOpts.placeHolder = placeholder;
        answer = await vscode.window.showInputBox(inputOpts);
      }
      return answer ?? '(cancelled)';
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
        description: 'Show a VS Code notification message (info, warning, or error).',
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

// ── copy_to_clipboard ─────────────────────────────────────────────────────────

export function makeCopyToClipboardTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'copy_to_clipboard',
        description: 'Copy text to the system clipboard.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to copy.' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      await vscode.env.clipboard.writeText(args['text'] as string);
      return 'Copied.';
    },
  };
}

// ── read_clipboard ────────────────────────────────────────────────────────────

export function makeReadClipboardTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_clipboard',
        description: 'Read the current contents of the system clipboard.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (_args) => {
      return vscode.env.clipboard.readText();
    },
  };
}

// ── open_url_in_browser ───────────────────────────────────────────────────────

export function makeOpenUrlTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'open_url_in_browser',
        description: 'Open a URL in the default external browser.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to open. Must start with https:// or http://.',
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const url = args['url'] as string;
      if (!url.startsWith('https://') && !url.startsWith('http://')) {
        throw new Error(
          `open_url_in_browser: URL must start with https:// or http://. Got: ${url}`,
        );
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return 'Opened.';
    },
  };
}

// ── Internal helper ───────────────────────────────────────────────────────────
