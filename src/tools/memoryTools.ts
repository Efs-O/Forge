import type * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { memoryStoreFor, renderMemoryLine } from '../memory/memoryStore';

const KEY_PREFIX = 'forge.memory.';
const KEYS_INDEX = 'forge.memory.__keys__';
const DESCRIPTIONS_INDEX = 'forge.memory.__descriptions__';
export const MEMORY_INDEX_MAX_LINES = 60;

function memoryKey(args: Record<string, unknown>, creating = false): string {
  const key = args['key'];
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    (creating && key.length > 200) ||
    (creating && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(key)) ||
    key === '__keys__' ||
    key === '__descriptions__'
  )
    throw new Error(
      'Memory key must be 1–200 characters, cannot be __keys__ or __descriptions__, and new keys use letters, digits, dots, underscores or hyphens.',
    );
  return key;
}

function legacyKeys(state: vscode.Memento): string[] {
  const index = state.get<unknown>(KEYS_INDEX);
  return Array.isArray(index)
    ? index.filter(
        (key): key is string =>
          typeof key === 'string' && typeof state.get(KEY_PREFIX + key) === 'string',
      )
    : [];
}

export function listMemoryKeys(state: vscode.Memento): string[] {
  return memoryStoreFor(state)?.listKeys() ?? legacyKeys(state);
}

export function renderMemoryIndexBlock(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  const newest = [...lines].reverse();
  const omitted = Math.max(0, newest.length - MEMORY_INDEX_MAX_LINES);
  const shown = newest.slice(0, MEMORY_INDEX_MAX_LINES);
  if (omitted > 0) shown.push(`${omitted} more not shown; \`list_memories\` lists them all.`);
  return [
    'Stored memories in this workspace (saved with `remember`; call `recall` with a key for its full value):',
    ...shown,
  ].join('\n');
}

export function listMemoryLines(state: vscode.Memento): string[] {
  const store = memoryStoreFor(state);
  if (store) return store.listLines();
  const descriptions = state.get<Record<string, unknown>>(DESCRIPTIONS_INDEX) ?? {};
  return legacyKeys(state).map((key) =>
    renderMemoryLine(
      key,
      typeof descriptions[key] === 'string' ? (descriptions[key] as string) : undefined,
    ),
  );
}

function requireStore(state: vscode.Memento) {
  const store = memoryStoreFor(state);
  if (!store) throw new Error('Workspace memory store is not initialized.');
  return store;
}

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
    permission: 'read',
    /** A memory is the one write that never leaves the machine yet changes every
     *  later chat: every new chat in this workspace starts with the stored keys, so
     *  a note a job wrote from a page it read is loaded by all of them, with nobody
     *  to check it. The owner's answer is a refusal that names the policy line, not
     *  a card nobody is there to click — and the run carries on and reports the
     *  memory it wanted instead. Attended chats and Clanker chats are unchanged. */
    unattendedGate: {
      detail: 'Store a workspace memory that every later chat in this workspace will load.',
      cardReason: 'The memory was NOT saved.',
      declineHint:
        'carry on without it, and list the memory you wanted to save (its key and its text) ' +
        'in your final report',
      softDenial: true,
    },
    handler: async (args) => {
      const key = memoryKey(args, true);
      const value = args['value'];
      if (typeof value !== 'string') throw new Error('Memory value must be a string.');
      const rawDescription = args['description'];
      const description =
        typeof rawDescription === 'string' && rawDescription.trim()
          ? rawDescription.trim()
          : undefined;
      await requireStore(state).remember(key, value, description);
      return description
        ? 'Remembered.'
        : `Stored "${key}" (description taken from its first line; pass description to write your own).`;
    },
  };
}

export function makeRecallTool(state: vscode.Memento): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'recall',
        description:
          'Retrieve a value stored with remember. After a compaction, the stored keys are listed in the replacement context.',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string', description: 'Memory key to look up.' } },
          required: ['key'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => requireStore(state).read(memoryKey(args))?.value ?? '(not found)',
  };
}

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
      const existed = await requireStore(state).forgetMemory(key);
      onForgot?.(key);
      return existed ? `Forgot "${key}".` : `Memory "${key}" was already absent.`;
    },
  };
}

export function makeListMemoriesTool(state: vscode.Memento): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_memories',
        description:
          'List every key stored with remember in this workspace. Use it when resuming work and the key you need is not in view.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    },
    permission: 'read',
    handler: async () => requireStore(state).listResult(),
  };
}
