import type * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'forge.memory.';
const KEYS_INDEX = 'forge.memory.__keys__';

/** Every stored key, oldest first. Also read by compaction, which lists them
 *  in the replacement context so `recall` has a key to ask for. */
export function listMemoryKeys(state: vscode.Memento): string[] {
  return (state.get(KEYS_INDEX) as string[] | undefined) ?? [];
}

// ── remember ──────────────────────────────────────────────────────────────────

export function makeRememberTool(state: vscode.Memento): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'remember',
        description:
          'Store a decision or pending state that must survive context compaction. Use it for ' +
          'anything not already in FORGE.md or the files that you would have to re-derive after ' +
          'a compaction. Keys are listed back to you after every compaction. Overwrites an ' +
          'existing key.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Memory key (used to recall later).' },
            value: { type: 'string', description: 'Value to store.' },
          },
          required: ['key', 'value'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read', // non-destructive: no file/terminal side-effects
    handler: async (args) => {
      const key = args['key'] as string;
      const value = args['value'] as string;

      await state.update(KEY_PREFIX + key, value);

      // Maintain the keys index so list_memories works
      const existingKeys = listMemoryKeys(state);
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
        description:
          'Retrieve a value stored with remember. After a compaction, the stored keys are ' +
          'listed in the replacement context.',
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
        description:
          'List every key stored with remember in this workspace. Use it when resuming work ' +
          'and the key you need is not in view.',
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
      const keys = listMemoryKeys(state);
      if (!keys.length) return '(no memories stored)';
      return keys.join('\n');
    },
  };
}
