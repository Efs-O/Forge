/**
 * Tool calls the model is still writing. llama-server streams a call's
 * arguments token by token, but the call only becomes a transcript row once
 * they are complete, so a large `write_file` used to leave the screen frozen
 * for minutes. These entries are transient: never persisted, never in
 * `messagesById`, and dropped when the call's row lands or the turn ends.
 */
export interface PendingToolCall {
  index: number;
  toolCallId?: string;
  toolName: string;
  target?: string;
  tokens: number;
}

export type PendingToolCalls = Map<string, PendingToolCall[]>;

function sameCall(a: PendingToolCall, b: PendingToolCall): boolean {
  return a.toolCallId !== undefined && b.toolCallId !== undefined
    ? a.toolCallId === b.toolCallId
    : a.index === b.index;
}

/** Inserts or refreshes one call's progress. */
export function withProgress(
  pending: PendingToolCalls,
  cid: string,
  call: PendingToolCall,
): PendingToolCalls {
  const calls = pending.get(cid) ?? [];
  const at = calls.findIndex((existing) => sameCall(existing, call));
  const next = at === -1 ? [...calls, call] : calls.map((c, i) => (i === at ? call : c));
  return new Map(pending).set(cid, next);
}

/**
 * Removes the call whose row just landed: by id when the host sent one, else
 * the oldest entry (calls are announced in the order they were written).
 */
export function withoutCall(
  pending: PendingToolCalls,
  cid: string,
  toolCallId: string | undefined,
): PendingToolCalls {
  const calls = pending.get(cid);
  if (!calls || calls.length === 0) return pending;
  const at = toolCallId ? calls.findIndex((c) => c.toolCallId === toolCallId) : -1;
  const drop = at === -1 ? 0 : at;
  return withoutConversation(
    pending,
    cid,
    calls.filter((_, i) => i !== drop),
  );
}

/** Drops every pending call of a conversation (turn ended). */
export function withoutConversation(
  pending: PendingToolCalls,
  cid: string,
  keep: PendingToolCall[] = [],
): PendingToolCalls {
  if (!pending.has(cid)) return pending;
  const next = new Map(pending);
  if (keep.length > 0) next.set(cid, keep);
  else next.delete(cid);
  return next;
}
