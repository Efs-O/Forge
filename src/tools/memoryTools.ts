import type * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'forge.memory.';
const KEYS_INDEX = 'forge.memory.__keys__';
const pendingWrites = new WeakMap<vscode.Memento, Promise<void>>();

function serialize(state: vscode.Memento, work: () => Promise<void>): Promise<void> {
  const previous = pendingWrites.get(state) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  pendingWrites.set(state, current);
  return current;
}

function memoryKey(args: Record<string, unknown>, creating = false): string {
  const key = args['key'];
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    (creating && key.length > 200) ||
    (creating && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(key)) ||
    key === '__keys__'
  ) {
    throw new Error(
      'Memory key must be 1–200 characters, cannot be __keys__, and new keys use letters, digits, dots, underscores or hyphens.',
    );
  }
  return key;
}

/** Every stored key, oldest first. Also read by compaction, which lists them
 *  in the replacement context so `recall` has a key to ask for. */
export function listMemoryKeys(state: vscode.Memento): string[] {
  const index = state.get<unknown>(KEYS_INDEX);
  if (!Array.isArray(index)) return [];
  return index.filter(
    (key): key is string =>
      typeof key === 'string' && typeof state.get(KEY_PREFIX + key) === 'string',
  );
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
      const key = memoryKey(args, true);
      const value = args['value'] as string;

      await serialize(state, async () => {
        const existingKeys = state.get<string[]>(KEYS_INDEX) ?? [];
        if (!existingKeys.includes(key)) await state.update(KEYS_INDEX, [...existingKeys, key]);
        await state.update(KEY_PREFIX + key, value);
      });

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
      const key = memoryKey(args);
      return (state.get(KEY_PREFIX + key) as string | undefined) ?? '(not found)';
    },
  };
}

/** Delete one workspace memory after the normal delete-capability confirmation. */
export function makeForgetTool(
  state: vscode.Memento,
  onForgot?: (key: string) => void,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'forget',
        description:
          'Remove one stored workspace memory by key when it is no longer useful. This does not clear other memories.',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string', description: 'The exact memory key to remove.' } },
          required: ['key'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delete',
    workspaceStateMutation: true,
    approval: (args) => ({ detail: `Remove stored workspace memory "${String(args['key'])}"?` }),
    handler: async (args) => {
      const key = memoryKey(args);
      let existed = false;
      let valueRemoved = false;
      try {
        await serialize(state, async () => {
          const index = state.get<string[]>(KEYS_INDEX) ?? [];
          existed = index.includes(key) || typeof state.get(KEY_PREFIX + key) === 'string';
          if (typeof state.get(KEY_PREFIX + key) === 'string') {
            await state.update(KEY_PREFIX + key, undefined);
            valueRemoved = true;
          }
          if (index.includes(key)) {
            await state.update(
              KEYS_INDEX,
              index.filter((entry) => entry !== key),
            );
          }
        });
      } catch (error) {
        // The value is already gone even if removing the stale index failed.
        if (valueRemoved) onForgot?.(key);
        throw error;
      }
      onForgot?.(key);
      return existed ? `Forgot "${key}".` : `Memory "${key}" was already absent.`;
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
