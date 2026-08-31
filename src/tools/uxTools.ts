import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import type { UserQuestionService } from '../sidebar/UserQuestionService';
import {
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

// ── ask_user ──────────────────────────────────────────────────────────────────

export function makeAskUserTool(questions: UserQuestionService): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_user',
        description:
          'Ask the user a question and wait for their answer. The question reaches ' +
          'whichever surface started the turn -- the VS Code window, or the chat it ' +
          'was driven from remotely.',
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
        return (
          `Notification limit reached for this turn (${NOTIFY_TURN_LIMIT}). ` +
          'The message was not sent -- put it in your final reply instead.'
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
