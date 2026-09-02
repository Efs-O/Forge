import type { DiffHunk } from '../../src/sidebar/messageBridge';

export interface AppMessage {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system' | 'tool' | 'diff';
  content: string;
  reasoning?: string | undefined;
  /**
   * Wall time the reasoning phase took, stamped live by the reducer. Absent on
   * rehydrated rows - `PersistedRow` does not carry it - so every reader must
   * render without it.
   */
  reasoningMs?: number;
  /** Set while reasoning is still streaming into this row. */
  reasoningStartedAt?: number;
  diffHunks?: DiffHunk[] | null;
  diffIsNew?: boolean;
  diffIsDeleted?: boolean;
  /** Tool rows: set on activity, then filled in when the call returns. */
  toolName?: string;
  toolCallId?: string;
  toolDetail?: string;
  toolResult?: string;
  toolResultTotal?: number;
  toolFilePath?: string;
  toolIsError?: boolean;
}

export type PersistedRow =
  | { role: 'user' | 'assistant'; content: string; reasoning?: string | undefined }
  | {
      role: 'tool';
      content: string;
      toolName: string;
      toolDetail?: string;
      toolResult: string;
      toolResultTotal: number;
      toolIsError?: boolean | undefined;
    }
  | {
      role: 'diff';
      content: string;
      diffHunks: DiffHunk[] | null;
      diffIsNew: boolean;
      diffIsDeleted: boolean;
    };

export function mkId(): string {
  return Math.random().toString(36).slice(2);
}

/**
 * Reconciles a conversation against the host's persisted view.
 *
 * The host persists completed tool rows too. Tool activity that has not yet
 * produced a result, plus diff cards and errors, remains local until the host
 * can authoritatively restore it. Those transient rows are kept in position
 * rather than appended to the tail where their ordering would be lost.
 *
 * If the two views disagree (for example, an assistant tool-call turn is not
 * renderable in the host view), local-only rows stay anchored before the next
 * matching host turn. That keeps tool activity before the final report instead
 * of moving it to the bottom after session reconciliation.
 */
export function mergeSyncedMessages(local: AppMessage[], rows: PersistedRow[]): AppMessage[] {
  const reconstructed: AppMessage[] = rows.map((m) => ({
    id: mkId(),
    role: m.role,
    content: m.content,
    ...((m.role === 'user' || m.role === 'assistant') && m.reasoning !== undefined
      ? { reasoning: m.reasoning }
      : {}),
    ...(m.role === 'tool'
      ? {
          toolName: m.toolName,
          ...(m.toolDetail !== undefined ? { toolDetail: m.toolDetail } : {}),
          toolResult: m.toolResult,
          toolResultTotal: m.toolResultTotal,
          ...(m.toolIsError ? { toolIsError: true } : {}),
        }
      : {}),
    ...(m.role === 'diff'
      ? {
          diffHunks: m.diffHunks,
          diffIsNew: m.diffIsNew,
          diffIsDeleted: m.diffIsDeleted,
        }
      : {}),
  }));

  // Match the local renderable rows to the authoritative host rows in order.
  // The host can omit an assistant tool-call turn (content: null), so this is
  // deliberately an ordered subsequence rather than a position-by-position map.
  const localToHost = new Map<number, number>();
  let hostCursor = 0;
  for (let localIndex = 0; localIndex < local.length; localIndex++) {
    const message = local[localIndex]!;
    // Diffs are now part of the authoritative transcript view. Errors and
    // notices remain webview-only, but a matching diff must replace its live
    // precursor instead of being kept as a duplicate or discarded on reload.
    if (message.role === 'error' || message.role === 'system') continue;
    const hostIndex = reconstructed.findIndex(
      (host, index) => index >= hostCursor && sameRenderableMessage(message, host),
    );
    if (hostIndex < 0) continue;
    localToHost.set(localIndex, hostIndex);
    reconstructed[hostIndex]!.id = message.id;
    if (message.role === 'tool' && message.toolDetail !== undefined) {
      reconstructed[hostIndex]!.toolDetail = message.toolDetail;
    }
    hostCursor = hostIndex + 1;
  }

  const before = new Map<number, AppMessage[]>();
  const after = new Map<number, AppMessage[]>();
  for (let localIndex = 0; localIndex < local.length; localIndex++) {
    const message = local[localIndex]!;
    const keepTransient =
      message.role === 'error' ||
      message.role === 'system' ||
      ((message.role === 'tool' || message.role === 'diff') && !localToHost.has(localIndex));
    if (!keepTransient) continue;
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
  if (local.role === 'tool' && host.role === 'tool') {
    return local.toolName === host.toolName && local.toolResult === host.toolResult;
  }
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
export function findPendingToolRow(
  messages: AppMessage[],
  toolName: string,
  toolCallId?: string,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (
      m.role === 'tool' &&
      m.toolName === toolName &&
      m.toolResult === undefined &&
      (toolCallId === undefined || m.toolCallId === toolCallId)
    ) {
      return i;
    }
  }
  return -1;
}
