import type * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_PREFIX  = 'forge.memory.';
const KEYS_INDEX  = 'forge.memory.__keys__';

// ── remember ──────────────────────────────────────────────────────────────────

export function makeRememberTool(state: vscode.Memento): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'remember',
        description: 'Store a key-value pair in the workspace memory for later recall.',
        parameters: {
          type: 'object',
          properties: {
            key:   { type: 'string', description: 'Memory key (used to recall later).' },
            value: { type: 'string', description: 'Value to store.' },
          },
          required: ['key', 'value'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read', // non-destructive: no file/terminal side-effects
    handler: async (args) => {
      const key   = args['key']   as string;
      const value = args['value'] as string;

      await state.update(KEY_PREFIX + key, value);

      // Maintain the keys index so list_memories works
      const existingKeys = (state.get(KEYS_INDEX) as string[] | undefined) ?? [];
      if (!existingKeys.includes(key)) {
        await state.update(KEYS_INDEX, [...existingKeys, key]);
      }

      return 'Remembered.';
    },
  };
}

// ── recall ────────────────────────────────────────────────────────────────────

export function makeRecallTool(state: vscode.Memento): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'recall',
        description: 'Retrieve a previously stored memory value by key.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Memory key to look up.' },
          },
          required: ['key'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const key = args['key'] as string;
      return (state.get(KEY_PREFIX + key) as string | undefined) ?? '(not found)';
    },
  };
}

// ── list_memories ─────────────────────────────────────────────────────────────

export function makeListMemoriesTool(state: vscode.Memento): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_memories',
        description: 'List all stored memory keys in this workspace.',
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
      const keys = (state.get(KEYS_INDEX) as string[] | undefined) ?? [];
      if (!keys.length) return '(no memories stored)';
      return keys.join('\n');
    },
  };
}
