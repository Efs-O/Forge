import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import type { UserQuestionService } from '../sidebar/UserQuestionService';
import {
  NOTIFY_IDLE_RESET_MS,
  NOTIFY_TURN_LIMIT,
  type UserNotificationService,
} from '../sidebar/UserNotificationService';

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

// ── open_file ─────────────────────────────────────────────────────────────────

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
              type: 'number',
              minimum: 1,
              description: 'Optional 1-based line to reveal and place the cursor on.',
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
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch (err) {
        throw new Error(`open_file: cannot open ${suppliedPath} — ${(err as Error).message}`);
      }
      // `line` arrives 1-based from the model; VS Code positions are 0-based.
      // A line past the end is clamped rather than refused: the file is open
      // either way, and a stale line number is not worth failing the call over.
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
      return zeroBased === undefined
        ? `Opened ${suppliedPath} in the editor.`
        : `Opened ${suppliedPath} in the editor at line ${zeroBased + 1}.`;
    },
  };
}

// ── ask_user ──────────────────────────────────────────────────────────────────

export function makeAskUserTool(questions: UserQuestionService): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_user',
        description:
          'Ask the user a question and BLOCK until they answer. The question ' +
          'reaches whichever surface started the turn -- the VS Code window, or ' +
          'the chat it was driven from remotely. There is no timeout: if the user ' +
          'has stepped away the turn stalls until they return, so do not use it ' +
          'to check in during long unattended work. When work can continue under ' +
          'a stated assumption, state the assumption, notify_user, and keep going. ' +
          'Ask one related decision group per call. When using options, keep them ' +
          'short and mutually exclusive. Ask an unrelated follow-up decision in ' +
          'the next ask_user call rather than appending it as an "also" question.',
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
              description: 'If provided, offers a fixed choice instead of free text.',
            },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      const answer = await questions.ask({
        prompt: args['prompt'] as string,
        placeholder: args['placeholder'] as string | undefined,
        options: args['options'] as string[] | undefined,
        conversationId: context?.conversationId,
        // Without this a cancelled turn leaves the question open forever: the
        // box no longer self-dismisses on blur, and a remote asker has no Esc.
        signal: context?.abortSignal,
      });
      // Say what happened rather than returning a bare "(cancelled)" the model
      // reads as an answer -- and name the alternative, so a dismissal ends the
      // turn in chat instead of re-asking into the same dead end.
      return (
        answer ??
        'The user did not answer: the question was dismissed without a response. ' +
          'Do not call ask_user again for this question -- ask it in your chat reply and end the turn.'
      );
    },
  };
}

// ── notify_user ───────────────────────────────────────────────────────────────

export function makeNotifyUserTool(notifications: UserNotificationService): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'notify_user',
        description:
          'Ping the user. THIS is the tool when they say "ping me", "notify me", ' +
          '"let me know", "tell me when", or "message me" -- prefer it over ' +
          'show_notification, which is only visible at the machine. Sends a short ' +
          'message that reaches whichever surface started the turn: the VS Code ' +
          'window, and the chat it was driven from remotely if there is one, so it ' +
          'still reaches a user who has walked away. Fire-and-forget -- it does NOT ' +
          'wait for a reply and does NOT pause your work. To ask a question and wait ' +
          'for an answer, use ask_user instead.',
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
      const chats = await notifications.notify({
        text: message,
        ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      });
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
          'Show a notification in the VS Code window ONLY (info, warning, or error). ' +
          'It is invisible to a user who has stepped away from the machine or is ' +
          'driving this turn from a phone. If the user asked to be pinged, notified, ' +
          'told, or messaged, call notify_user instead -- it reaches this window AND ' +
          'the chat that started the turn. Use this one only for a cue that matters ' +
          'solely to someone sitting at the editor.',
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
