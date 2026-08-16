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
 * If the two views disagree (for example, an assistant tool-call turn is not
 * renderable in the host view), local-only rows stay anchored before the next
 * matching host turn. That keeps tool activity before the final report instead
 * of moving it to the bottom after session reconciliation.
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

  // Match the local renderable rows to the authoritative host rows in order.
  // The host can omit an assistant tool-call turn (content: null), so this is
  // deliberately an ordered subsequence rather than a position-by-position map.
  const localToHost = new Map<number, number>();
  let hostCursor = 0;
  for (let localIndex = 0; localIndex < local.length; localIndex++) {
    const message = local[localIndex]!;
    if (LOCAL_ONLY_ROLES.has(message.role)) continue;
    const hostIndex = reconstructed.findIndex(
      (host, index) => index >= hostCursor && sameRenderableMessage(message, host),
    );
    if (hostIndex < 0) continue;
    localToHost.set(localIndex, hostIndex);
    hostCursor = hostIndex + 1;
  }

  const before = new Map<number, AppMessage[]>();
  const after = new Map<number, AppMessage[]>();
  for (let localIndex = 0; localIndex < local.length; localIndex++) {
    const message = local[localIndex]!;
    if (!LOCAL_ONLY_ROLES.has(message.role)) continue;
    const nextHost = nearestMappedHost(localToHost, localIndex, 1, local.length);
    if (nextHost !== undefined) {
      appendRow(before, nextHost, message);
      continue;
    }
    const previousHost = nearestMappedHost(localToHost, localIndex, -1, -1);
    if (previousHost !== undefined) appendRow(after, previousHost, message);
  }

  return reconstructed.flatMap((message, index) => [
    ...(before.get(index) ?? []),
    message,
    ...(after.get(index) ?? []),
  ]);
}

function sameRenderableMessage(local: AppMessage, host: AppMessage): boolean {
  return (
    local.role === host.role && local.content === host.content && local.reasoning === host.reasoning
  );
}

function nearestMappedHost(
  mapped: ReadonlyMap<number, number>,
  from: number,
  step: 1 | -1,
  stop: number,
): number | undefined {
  for (let index = from + step; index !== stop; index += step) {
    const host = mapped.get(index);
    if (host !== undefined) return host;
  }
  return undefined;
}

function appendRow(rows: Map<number, AppMessage[]>, index: number, message: AppMessage): void {
  const existing = rows.get(index);
  if (existing) existing.push(message);
  else rows.set(index, [message]);
}

/** Index of the newest unresolved activity row for a tool, or -1. */
export function findPendingToolRow(messages: AppMessage[], toolName: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.toolName === toolName && m.toolResult === undefined) return i;
  }
  return -1;
}
