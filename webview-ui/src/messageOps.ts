import type { DiffHunk } from '../../src/sidebar/messageBridge';

export interface AppMessage {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system' | 'tool' | 'diff';
  content: string;
  reasoning?: string | undefined;
  diffHunks?: DiffHunk[] | null;
  diffIsNew?: boolean;
  diffIsDeleted?: boolean;
  /** Tool rows: set on activity, then filled in when the call returns. */
  toolName?: string;
  toolResult?: string;
  toolResultTotal?: number;
  toolFilePath?: string;
  toolIsError?: boolean;
}

export type PersistedRow = {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | undefined;
};

/**
 * Roles the host never persists. They are reconciled positionally on
 * SESSION_SYNC so a finished turn keeps showing the work it did.
 */
export const LOCAL_ONLY_ROLES = new Set<AppMessage['role']>(['tool', 'diff', 'error']);

export function mkId(): string {
  return Math.random().toString(36).slice(2);
}

/**
 * Reconciles a conversation against the host's persisted view.
 *
 * The host only persists user and assistant turns, so a naive rebuild wipes the
 * tool rows, diff cards and errors that make a finished turn legible — that is
 * what made the agent's work vanish the moment it stopped. Local-only rows are
 * therefore kept *in position* by walking both lists together, rather than being
 * appended to the tail where their ordering would be lost.
 *
 * If the two views disagree on how many persisted rows exist (compaction, undo,
 * a restore), the host wins and local-only rows fall back to the tail.
 */
export function mergeSyncedMessages(local: AppMessage[], rows: PersistedRow[]): AppMessage[] {
  const persistedLocal = local.filter((m) => !LOCAL_ONLY_ROLES.has(m.role));
  const reconstructed: AppMessage[] = rows.map((m, i) => ({
    // Reuse the existing id where the row still matches, so React keeps
    // component state (open thinking rows, scroll) across reconciliation.
    id: persistedLocal[i]?.role === m.role ? persistedLocal[i]!.id : mkId(),
    role: m.role,
    content: m.content,
    reasoning: m.reasoning,
  }));

  if (persistedLocal.length !== reconstructed.length) {
    return [...reconstructed, ...local.filter((m) => LOCAL_ONLY_ROLES.has(m.role))];
  }

  let next = 0;
  return local.map((m) => (LOCAL_ONLY_ROLES.has(m.role) ? m : reconstructed[next++]!));
}

/** Index of the newest unresolved activity row for a tool, or -1. */
export function findPendingToolRow(messages: AppMessage[], toolName: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.toolName === toolName && m.toolResult === undefined) return i;
  }
  return -1;
}
