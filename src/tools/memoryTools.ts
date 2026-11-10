import type * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'forge.memory.';
const KEYS_INDEX = 'forge.memory.__keys__';
const DESCRIPTIONS_INDEX = 'forge.memory.__descriptions__';
export const MEMORY_INDEX_MAX_LINES = 30;
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
    key === '__keys__' ||
    key === '__descriptions__'
  ) {
    throw new Error(
      'Memory key must be 1–200 characters, cannot be __keys__ or __descriptions__, and new keys use letters, digits, dots, underscores or hyphens.',
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

/** Render one indexed memory, keeping legacy memories readable without a description. */
export function renderMemoryLine(key: string, description?: string): string {
  if (!description) return `- ${key}`;
  const firstLine = description.split(/\r\n|\r|\n/u, 1)[0] ?? '';
  const shownDescription = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  return shownDescription ? `- ${key}: ${shownDescription}` : `- ${key}`;
}

/** Render the initial-chat index, newest first, with a bounded prompt cost. */
export function renderMemoryIndexBlock(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  const newest = [...lines].reverse();
  const omitted = Math.max(0, newest.length - MEMORY_INDEX_MAX_LINES);
  const shown = newest.slice(0, MEMORY_INDEX_MAX_LINES);
  if (omitted > 0) {
    shown.push(`${omitted} more not shown; \`list_memories\` lists them all.`);
  }
  return [
    'Stored memories in this workspace (saved with `remember`; call `recall` with a key for its full value):',
    ...shown,
  ].join('\n');
}

/** Every indexed memory, oldest first, formatted for display. */
export function listMemoryLines(state: vscode.Memento): string[] {
  const descriptions = state.get<unknown>(DESCRIPTIONS_INDEX);
  const descriptionMap =
    descriptions && typeof descriptions === 'object' && !Array.isArray(descriptions)
      ? (descriptions as Record<string, unknown>)
      : {};
  return listMemoryKeys(state).map((key) => {
    const description = descriptionMap[key];
    return renderMemoryLine(key, typeof description === 'string' ? description : undefined);
  });
}

// ── remember ──────────────────────────────────────────────────────────────────

export function makeRememberTool(state: vscode.Memento): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'remember',
        description:
          'Store a decision or pending state that must survive context compaction or help a later chat. Use it for anything not already in FORGE.md or the files that you would have to re-derive. Every new chat in this workspace starts with the stored keys and their descriptions, and the keys are listed back to you after every compaction. Overwrites an existing key and its description.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Memory key (used to recall later).' },
            value: { type: 'string', description: 'Value to store.' },
            description: {
              type: 'string',
              description:
                'One line saying what this memory holds. Every new chat in this workspace starts with the list of keys and these descriptions.',
            },
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
      const rawDescription = args['description'];
      const description =
        typeof rawDescription === 'string' && rawDescription.trim().length > 0
          ? rawDescription.trim()
          : undefined;

      await serialize(state, async () => {
        const existingKeys = state.get<string[]>(KEYS_INDEX) ?? [];
        if (!existingKeys.includes(key)) await state.update(KEYS_INDEX, [...existingKeys, key]);
        await state.update(KEY_PREFIX + key, value);
        const descriptions = state.get<Record<string, string>>(DESCRIPTIONS_INDEX) ?? {};
        const nextDescriptions = { ...descriptions };
        if (description === undefined) delete nextDescriptions[key];
        else nextDescriptions[key] = description;
        await state.update(DESCRIPTIONS_INDEX, nextDescriptions);
      });

      return description
        ? 'Remembered.'
        : 'Remembered. Without a description, new chats list only the key; call remember again with a description to add one.';
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
    approval: (args) => ({
      detail: `Remove stored workspace memory "${String(args['key'])}"?`,
      clankerStop: true,
    }),
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
          const descriptions = state.get<Record<string, string>>(DESCRIPTIONS_INDEX) ?? {};
          if (Object.prototype.hasOwnProperty.call(descriptions, key)) {
            const nextDescriptions = { ...descriptions };
            delete nextDescriptions[key];
            await state.update(DESCRIPTIONS_INDEX, nextDescriptions);
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
      return listMemoryLines(state).join('\n');
    },
  };
}
