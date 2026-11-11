/**
 * The clipboard tools: copy text to the system clipboard and read it back.
 * Split out of `uxTools.ts`, which holds the editor and notification surfaces;
 * the clipboard is a separate concern with nothing shared beyond the VS Code API.
 */
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

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
