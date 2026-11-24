import type * as vscode from 'vscode';
import { descriptionFor, type StoredMemory } from './memoryFileFormat';

/**
 * The workspace memories that predate the markdown files: the VS Code Memento
 * records `MemoryStore.migrate` moves out, and the storage a failed migration
 * leaves them in. `memoryStore.ts` decides which backend answers; this module
 * implements only the Memento one.
 */

export const KEY_PREFIX = 'forge.memory.';
export const KEYS_INDEX = 'forge.memory.__keys__';
export const DESCRIPTIONS_INDEX = 'forge.memory.__descriptions__';

export function legacyEntries(state: vscode.Memento): StoredMemory[] {
  const keys = state.get<unknown>(KEYS_INDEX);
  const descriptions = state.get<Record<string, unknown>>(DESCRIPTIONS_INDEX) ?? {};
  if (!Array.isArray(keys)) return [];
  const baseTime = Date.now();
  return keys.flatMap((key, index) => {
    const value = typeof key === 'string' ? state.get<unknown>(KEY_PREFIX + key) : undefined;
    if (typeof key !== 'string' || typeof value !== 'string') return [];
    return [
      {
        key,
        value,
        description: descriptionFor(
          value,
          typeof descriptions[key] === 'string' ? (descriptions[key] as string) : undefined,
        ),
        fileName: '',
        updated: new Date(baseTime + index).toISOString(),
      },
    ];
  });
}

export async function legacyRemember(
  state: vscode.Memento,
  key: string,
  value: string,
  description?: string,
): Promise<void> {
  const keys = state.get<string[]>(KEYS_INDEX) ?? [];
  if (!keys.includes(key)) await state.update(KEYS_INDEX, [...keys, key]);
  await state.update(KEY_PREFIX + key, value);
  const descriptions = state.get<Record<string, string>>(DESCRIPTIONS_INDEX) ?? {};
  await state.update(DESCRIPTIONS_INDEX, {
    ...descriptions,
    [key]: descriptionFor(value, description),
  });
}

/**
 * `exists` is a callback rather than a boolean so the read that answers it
 * still runs inside the caller's queue slot: `forgetMemory` computed it inside
 * `serializeLegacy`, and hoisting it out of the serialised section would be a
 * different, racier order.
 */
export async function legacyForget(
  state: vscode.Memento,
  key: string,
  exists: () => boolean,
): Promise<boolean> {
  const existed = exists();
  await state.update(KEY_PREFIX + key, undefined);
  const keys = state.get<string[]>(KEYS_INDEX) ?? [];
  await state.update(
    KEYS_INDEX,
    keys.filter((entry) => entry !== key),
  );
  const descriptions = state.get<Record<string, string>>(DESCRIPTIONS_INDEX) ?? {};
  const next = { ...descriptions };
  delete next[key];
  await state.update(DESCRIPTIONS_INDEX, next);
  return existed;
}
