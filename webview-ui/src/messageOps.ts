import type { ChatAttachmentRef, DiffHunk } from '../../src/sidebar/messageBridge';

/**
 * One file shown under a message bubble.
 *
 * `src` is a `data:` URL while the prompt is still local (the webview holds the
 * bytes it just sent) and a webview URI once the host has persisted it. Only
 * the persisted form has a `relativePath`, and only that form can be opened:
 * there is nothing on disk to open until the host has written it.
 */
export interface MessageAttachment {
  name: string;
  mediaType: string;
  bytes: number;
  src: string;
  relativePath?: string;
}

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
  /** System rows only: render verbatim in a monospace block rather than as a
   *  centred one-line status row. Set by reports whose columns carry meaning. */
  preformatted?: boolean;
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
  /** Wall clock the call was announced at, and how long it ran. */
  toolStartedAt?: number;
  toolMs?: number;
  /** Files the user's prompt carried, rendered under the bubble. */
  attachments?: MessageAttachment[];
}

export type PersistedRow =
  | {
      role: 'user' | 'assistant';
      content: string;
      reasoning?: string | undefined;
      reasoningMs?: number | undefined;
      attachments?: ChatAttachmentRef[] | undefined;
    }
  | {
      role: 'tool';
      content: string;
      toolName: string;
      toolDetail?: string;
      toolResult: string;
      toolResultTotal: number;
      toolIsError?: boolean | undefined;
      toolMs?: number | undefined;
    }
  | {
      role: 'diff';
      content: string;
      diffHunks: DiffHunk[] | null;
      diffIsNew: boolean;
      diffIsDeleted: boolean;
    };

/**
 * A stored reference becomes renderable only once the host has told us where
 * its store is. Without that prefix the row still lists the file by name and
 * size — a missing thumbnail is a smaller loss than a broken one.
 */
function restoredAttachment(ref: ChatAttachmentRef, root?: string): MessageAttachment {
  return {
    name: ref.name,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    src: root ? `${root.replace(/\/$/u, '')}/${ref.relativePath}` : '',
    relativePath: ref.relativePath,
  };
}

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
export function mergeSyncedMessages(
  local: AppMessage[],
  rows: PersistedRow[],
  attachmentsRoot?: string,
): AppMessage[] {
  const reconstructed: AppMessage[] = rows.map((m) => ({
    id: mkId(),
    role: m.role,
    content: m.content,
    ...((m.role === 'user' || m.role === 'assistant') && m.reasoning !== undefined
      ? { reasoning: m.reasoning }
      : {}),
    ...((m.role === 'user' || m.role === 'assistant') && m.reasoningMs !== undefined
      ? { reasoningMs: m.reasoningMs }
      : {}),
    ...((m.role === 'user' || m.role === 'assistant') && m.attachments?.length
      ? { attachments: m.attachments.map((ref) => restoredAttachment(ref, attachmentsRoot)) }
      : {}),
    ...(m.role === 'tool'
      ? {
          toolName: m.toolName,
          ...(m.toolDetail !== undefined ? { toolDetail: m.toolDetail } : {}),
          toolResult: m.toolResult,
          toolResultTotal: m.toolResultTotal,
          ...(m.toolIsError ? { toolIsError: true } : {}),
          ...(m.toolMs !== undefined ? { toolMs: m.toolMs } : {}),
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

  // Hydrating an empty conversation - a tab switch, a reload, a restored
  // webview - has nothing to reconcile against, and this is the hot path: the
  // matching below compares full message bodies, so skipping it is worth the
  // early return rather than letting it fall out of the loop below.
  if (local.length === 0) return reconstructed;

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
    // Scan forward from the cursor rather than `findIndex` from zero. The old
    // predicate rejected everything below `hostCursor` anyway, so this matches
    // exactly the same rows - but it walks each host row once across the whole
    // loop instead of once per local row. That quadratic scan, with a full
    // `content` string compare at every step, was ~500k comparisons on a
    // 1000-row transcript, paid on every sync for every conversation.
    let hostIndex = -1;
    for (let index = hostCursor; index < reconstructed.length; index++) {
      if (sameRenderableMessage(message, reconstructed[index]!)) {
        hostIndex = index;
        break;
      }
    }
    if (hostIndex < 0) continue;
    localToHost.set(localIndex, hostIndex);
    reconstructed[hostIndex]!.id = message.id;
    if (message.role === 'tool' && message.toolDetail !== undefined) {
      reconstructed[hostIndex]!.toolDetail = message.toolDetail;
    }
    // The host's span wins where it has one - it is the side that saw both ends
    // and the only side that survives a reload. The webview's live stamp fills
    // the gap before the first sync, and permanently for the CLI-agent turns the
    // host does not time. Without this carry-over a mid-session sync replaced
    // every measured row with an unmeasured copy of itself, and the timings the
    // reducer had just stamped disappeared from a running turn - which looked
    // exactly like timing that had never been implemented.
    if (reconstructed[hostIndex]!.reasoningMs === undefined && message.reasoningMs !== undefined) {
      reconstructed[hostIndex]!.reasoningMs = message.reasoningMs;
    }
    if (reconstructed[hostIndex]!.toolMs === undefined && message.toolMs !== undefined) {
      reconstructed[hostIndex]!.toolMs = message.toolMs;
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

/**
 * Shallow row equality for `React.memo` on the grouped rows.
 *
 * The group components take arrays, and `mergeSyncedMessages` allocates a fresh
 * object per row on every sync, so the default shallow compare on the array
 * prop can never hit. Comparing every own key generically - rather than naming
 * the fields each group happens to render - is the version that cannot drift as
 * `AppMessage` grows: a new field is compared the day it is added.
 *
 * Conservative by construction. Non-primitive fields (`diffHunks`) compare by
 * identity, so a group holding one reports "not equal" and re-renders; that
 * costs a render it might not have needed, never a stale one.
 */
function sameRow(a: AppMessage, b: AppMessage): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (
      (a as unknown as Record<string, unknown>)[key] !==
      (b as unknown as Record<string, unknown>)[key]
    ) {
      return false;
    }
  }
  return true;
}

export function sameRowList(a: readonly AppMessage[], b: readonly AppMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!sameRow(a[index]!, b[index]!)) return false;
  }
  return true;
}
