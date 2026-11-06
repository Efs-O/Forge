/**
 * The two flags that say what a chat has already let in, and what it has read.
 *
 * Stealing a secret takes two steps in a row: read it, then send it out. The
 * gates in `secretPaths.ts` and `fetchHostApprovals.ts` each stop one of those
 * steps on its own; this flag is what connects them, so a chat that has read
 * `.env` pays for it on its next fetch and nowhere else.
 *
 * The second flag is the other half of the same question. A page, a search
 * result, a browser snapshot or a reply from an MCP server is content this chat
 * did not choose — a model can be told what to do by the text it is reading,
 * which is prompt injection. Once any of it has entered, everything this chat
 * sends out may have been chosen by that text rather than by the owner, so
 * `src/sidebar/untrustedExitPolicy.ts` puts a card on the ways out: network
 * egress, a message to another chat, a delegation. A chat with neither flag has
 * nothing in it that an outside page could have steered, so its shell, edits and
 * builds run with no card at all.
 *
 * Both flags are owned here, and only here, because they are the same question
 * asked from two ends — "is there anything in this chat that a page, not the
 * owner, chose?" — and a decision that needs one answer needs both: a chat that
 * read a secret is under the same egress rule as one that read a page, and a
 * gate that checked only one of them would let the other walk out the same door.
 *
 * Where the value lives: the untrusted flag is CONVERSATION state, and a chat's
 * stored record carries `untrusted_since_ms` (`src/sidebar/sessionTypes.ts`), so
 * a window reload cannot clear it while the page that brought it in is still in
 * context. This file holds the live copy as a Map rather than a store handle,
 * because every reader that asks — `fetchHostApprovals.ts`,
 * `untrustedExitPolicy.ts`, `ToolApprovalService` — has a conversation id and
 * not the conversation. The decision side is `carriesUntrustedContent` below,
 * which `ToolDispatch.ts` asks at every gate: it reconciles the three sources —
 * the live mark, the number the record carries, and any untrusted tool row still
 * in the transcript — and stamps the earliest back onto the conversation, so a
 * lost save fails CLOSED, not open. Each row is judged by the tool that produced
 * it, never by the tool being decided now.
 *
 * The secret flag stays in memory, deliberately: it is cleared with the chat, a
 * crash loses it (which fails open), and that is still sound because the secret
 * read itself already needed an approval — this flag is a second lock, not the
 * first.
 */

import { neverRanResult } from '../sidebar/toolResultView';

/** A tool row, as a conversation transcript holds it: the tool that produced it
 *  and the time it was produced. Structural, so this file needs no import of the
 *  transcript type and a test can hand it plain objects. */
export interface TranscriptToolRow {
  role: string;
  /** The tool that made this row, as the transcript names it (`name`). */
  name?: string;
  /** The result text the tool returned, as the transcript stores it. Optional and
   *  `unknown` because this table stays structural: a caller that only has the
   *  times can hand rows without it, and a test can hand plain objects. It is read
   *  for one question only — whether this call ever ran (`neverRanResult`), which
   *  is what tells a refused fetch from a fetch that brought a page in. */
  content?: unknown;
  createdAt?: number;
  stampedAt?: number;
}

/** The part of a conversation this file needs to keep its flag in step: the id,
 *  the persisted flag, and the rows it can re-derive the flag from. */
export interface UntrustedFlagConversation {
  id: string;
  /** Moment outside content first entered this chat, written by the host and
   *  persisted with the conversation. Absent means nothing has stamped it yet —
   *  which is what makes the transcript re-derivation matter. */
  untrusted_since_ms?: number;
  messages: readonly TranscriptToolRow[];
}

const chatsThatReadSecret = new Set<string>();
const secretReadReasons = new Map<string, { pattern: string; excerpt: string }>();
const chatsWithUntrustedContent = new Map<string, number>();

/** Called when an approved read of a secret path actually ran in this chat. */
export function markConversationReadSecret(
  conversationId: string | undefined,
  pattern = 'secret path',
  excerpt = 'approved read',
): void {
  if (!conversationId) return;
  chatsThatReadSecret.add(conversationId);
  if (!secretReadReasons.has(conversationId)) {
    secretReadReasons.set(conversationId, {
      pattern: pattern.slice(0, 100),
      excerpt: excerpt.replace(/\s+/gu, ' ').trim().slice(0, 120),
    });
  }
}

/** The first read that tainted this chat, for the next owner-facing egress card. */
export function conversationSecretReadReason(
  conversationId: string | undefined,
): string | undefined {
  if (!conversationId || !chatsThatReadSecret.has(conversationId)) return undefined;
  const reason = secretReadReasons.get(conversationId);
  if (!reason) return 'this chat has read a secret path';
  return `this chat read a secret path (${reason.pattern}, from: ${reason.excerpt}); approve sends this request anyway`;
}

/** Has this chat read (or been approved to read) a secret file? */
export function hasConversationReadSecret(conversationId: string | undefined): boolean {
  return conversationId !== undefined && chatsThatReadSecret.has(conversationId);
}

/**
 * Called when content from outside this machine entered this chat: the result of
 * `web_fetch`, `web_search`, `image_search`, a browser tool or an MCP server.
 *
 * The first call is the one that counts, so the stamp is written once and never
 * moved forward: a flag that resets on the next fetch would let a chat that has
 * read four pages forget the first one.
 */
export function markConversationReadUntrusted(
  conversationId: string | undefined,
  since: number = Date.now(),
): void {
  if (!conversationId) return;
  const existing = chatsWithUntrustedContent.get(conversationId);
  if (existing === undefined || since < existing)
    chatsWithUntrustedContent.set(conversationId, since);
}

/** Has this chat had outside content in it? */
export function hasConversationReadUntrusted(conversationId: string | undefined): boolean {
  return conversationId !== undefined && chatsWithUntrustedContent.has(conversationId);
}

/**
 * Is anything in this chat an outside choice — a page read, or a secret read?
 *
 * Both answers mean the same thing to the egress rule, and this is where they
 * are joined, so no caller has to remember that the other flag exists.
 */
export function conversationIsFlagged(conversationId: string | undefined): boolean {
  return hasConversationReadUntrusted(conversationId) || hasConversationReadSecret(conversationId);
}

/** Chat closed, `/clearChat`, window reload: the flag goes with the chat. */
export function clearConversationSecretState(conversationId?: string): void {
  if (conversationId === undefined) {
    chatsThatReadSecret.clear();
    secretReadReasons.clear();
  } else {
    chatsThatReadSecret.delete(conversationId);
    secretReadReasons.delete(conversationId);
  }
}

/** Every chat currently flagged — for the tests that prove clearing works. */
export function conversationsWithSecretRead(): string[] {
  return [...chatsThatReadSecret];
}

/** The untrusted-content flag, cleared with the chat. `undefined` clears every chat. */
export function clearConversationUntrustedState(conversationId?: string): void {
  if (conversationId === undefined) chatsWithUntrustedContent.clear();
  else chatsWithUntrustedContent.delete(conversationId);
}

/** Every chat that currently carries outside content. */
export function conversationsWithUntrustedContent(): string[] {
  return [...chatsWithUntrustedContent.keys()];
}

/**
 * Clear BOTH flags for one chat, or for every chat.
 *
 * They clear together because they start together: a new chat, or `/clear`, is a
 * chat that has read nothing, and a half-cleared chat would keep paying egress
 * cards for content its transcript no longer has.
 */
export function clearConversationExfilState(conversationId?: string): void {
  clearConversationSecretState(conversationId);
  clearConversationUntrustedState(conversationId);
}

/**
 * Rebuild the flag from the transcript: the earliest tool row whose result came
 * from outside this machine, or `undefined` when no such row survives.
 *
 * This is the fail-closed half. `untrusted_since_ms` is a stamp the host writes
 * beside the messages, and a save can be lost — a crash between the write and
 * the rename, an archive built from an older record, a field a future format
 * forgets. Deriving from the rows means a lost stamp costs nothing: the row that
 * brought the page in is still in the conversation, and so is the reason this
 * chat cannot send anything out unasked.
 *
 * `isUntrustedResult` is the registry's answer (`RegisteredTool.untrustedResult`),
 * not a name list kept here, because the tools that bring content in are decided
 * where those tools are registered — an MCP server's tool names come from the
 * server and cannot be spelled in advance.
 */
export function deriveUntrustedSinceMs(
  rows: readonly TranscriptToolRow[],
  isUntrustedResult: (toolName: string) => boolean,
): number | undefined {
  let earliest: number | undefined;
  for (const row of rows) {
    if (row.role !== 'tool' || !row.name || !isUntrustedResult(row.name)) continue;
    // A call refused before its handler ran brought nothing in, so it is not
    // evidence this chat read outside content: a `web_fetch` a policy denied left
    // no page, and flagging on it made the NEXT call pay an egress card for a read
    // that never happened. Every other row still flags — a row with no `content`
    // at all, and an `Error:` whose handler may have read a page before it failed.
    // That is the fail-CLOSED direction: only a row that can be proved to have run
    // nowhere is skipped.
    if (typeof row.content === 'string' && neverRanResult(row.content)) continue;
    const at = row.stampedAt ?? row.createdAt;
    // A row with no time still flags the chat: the flag is the fact, not the
    // timestamp, and a fact cannot be un-learned because its clock went missing.
    if (at === undefined) return 0;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * Bring one conversation's flag in step with what it has actually read, and
 * stamp the value the host will persist.
 *
 * Three sources, and the earliest wins, because the flag only ever gets older:
 * the number already stored on the conversation, the number derived from its
 * transcript, and the live mark set when the tool result arrived. A stored
 * number that the transcript contradicts is kept — the row that brought the
 * content in may have been compacted away while its effect on the chat stays.
 *
 * Returns the effective stamp, or `undefined` for a chat that has read nothing
 * from outside. Called at the start of each turn by `AgentLoop`, which is where
 * the live conversation and the registry are both in reach.
 */
export function syncConversationUntrustedFlag(
  conversation: UntrustedFlagConversation,
  isUntrustedResult: (toolName: string) => boolean,
): number | undefined {
  const stored = conversation.untrusted_since_ms;
  const derived = deriveUntrustedSinceMs(conversation.messages, isUntrustedResult);
  const live = chatsWithUntrustedContent.get(conversation.id);
  const candidates = [stored, derived, live].filter(
    (value): value is number => value !== undefined,
  );
  let effective: number | undefined;
  for (const value of candidates) {
    if (effective === undefined || value < effective) effective = value;
  }
  if (effective === undefined) return undefined;
  // The host's copy and the store's copy must not drift: this is the single
  // place that reconciles them, and both readers see the same number after it.
  conversation.untrusted_since_ms = effective;
  markConversationReadUntrusted(conversation.id, effective);
  return effective;
}

/**
 * Does this chat carry content it did not choose? This is the question a gate
 * asks, asked from every source that still holds the answer, because each one
 * covers a case the others miss: the live mark (this window, set the moment the
 * result arrived), the number the conversation record carries (survives a window
 * reload, and a compaction that drops the row which brought the page in), and
 * the rows still in the conversation's own transcript (so a lost save fails
 * CLOSED). When a conversation is in reach it goes through
 * `syncConversationUntrustedFlag`, which is also what stamps the earliest value
 * back onto the record and into the live Map, so the two copies cannot drift.
 *
 * The rows are judged by the tool that PRODUCED each one, asked of `registry` by
 * name inside `deriveUntrustedSinceMs`. That is the whole point of this function:
 * closing over the tool being decided now was the defect (BL-028) — a chat that
 * had read a page read as CLEAN when its next call was a `shell` carrying a
 * `curl`, because `shell` has no `untrustedResult` of its own, and a clean chat
 * read as FLAGGED on its first `web_fetch` after a reload, because that tool does.
 */
export function carriesUntrustedContent(
  conversationId: string | undefined,
  conversation: UntrustedFlagConversation | undefined,
  registry: { get(name: string): { untrustedResult?: boolean } | undefined },
): boolean {
  const isUntrustedResult = (name: string): boolean => registry.get(name)?.untrustedResult === true;
  if (conversation)
    return syncConversationUntrustedFlag(conversation, isUntrustedResult) !== undefined;
  // No conversation in reach means there is nothing to reconcile, so the live mark
  // is all that can answer. Only tests reach this line today; a production caller
  // that ever dispatches without a conversation has to fail CLOSED here, not read
  // the chat as clean — Claude named this when reviewing BL-028.
  return hasConversationReadUntrusted(conversationId);
}
