/**
 * Which turn each live rich-draft preview belongs to.
 *
 * Telegram's Stop update names only the chat and the draft id — no user, no
 * message id, and no conversation. So the only way to turn a button press into
 * the right `host.cancel` is to remember the association when the draft was
 * opened. It is deliberately in-memory: a draft preview expires on Telegram's
 * side after roughly 30 seconds, so a registry that outlived the process would
 * only ever hold ids that can no longer be pressed.
 *
 * Keyed by `chatId:draftId`, not by draft id alone. A Stop update carries the
 * chat, and requiring both halves to match is what makes a stale or foreign
 * draft id a no-op instead of a cancellation of somebody else's turn. Ids come
 * from `TelegramRichDrafts`: random-start, then monotonic, and never reused
 * within an instance — so an id from a finished turn is never the id of a
 * later one, including across a restart (which is why the start is not 1).
 */
export interface ActiveDraft {
  chatId: string;
  conversationId: string;
  draftId: number;
}

export class RemoteDraftRegistry {
  private readonly byKey = new Map<string, ActiveDraft>();
  /**
   * Ownership epoch: advanced every time the pairing that could answer a Stop
   * is revoked. A draft open is an await, so the pairing in force when the open
   * started may be gone by the time it returns; the epoch is what lets the
   * opener tell "this preview is mine to register" from "this preview belongs
   * to a pairing that has already been revoked."
   */
  private generation = 0;

  /**
   * One draft per conversation. A turn that somehow opens twice must not leave
   * two live ids: the second press would then be ambiguous about which preview
   * the user meant, and the first id would linger as a cancel path for a turn
   * nobody is watching.
   */
  register(draft: ActiveDraft): void {
    this.forgetConversation(draft.conversationId);
    this.byKey.set(this.key(draft.chatId, draft.draftId), draft);
  }

  /** The active draft for this chat+id, or undefined for a stale/foreign one. */
  find(chatId: string, draftId: number): ActiveDraft | undefined {
    return this.byKey.get(this.key(chatId, draftId));
  }

  /**
   * Atomically claim a draft: return it and drop the entry in one step.
   *
   * A Stop handler must claim before it awaits anything. `find` followed by a
   * separate `forget` leaves a window across the await, and two Stop updates
   * delivered back to back would both see the entry and both cancel — the
   * single-threaded event loop does not help when the check and the removal are
   * separated by an await.
   */
  take(chatId: string, draftId: number): ActiveDraft | undefined {
    const key = this.key(chatId, draftId);
    const draft = this.byKey.get(key);
    if (draft) this.byKey.delete(key);
    return draft;
  }

  /** Drops the entry for one conversation (turn ended, draft no longer live). */
  forgetConversation(conversationId: string): void {
    for (const [key, draft] of this.byKey) {
      if (draft.conversationId === conversationId) this.byKey.delete(key);
    }
  }

  /**
   * Drops every entry, used when a channel is unpaired.
   *
   * Unpairing revokes the owner for the whole channel, so no live draft on it
   * is answerable any more. Leaving the entries behind would keep a stale
   * chat+id pair claimable inside the same window — and a re-paired chat is a
   * different principal, so an entry inherited across an unpair is not the
   * user's own Stop.
   */
  forgetAll(): void {
    this.generation += 1;
    this.byKey.clear();
  }

  /**
   * The pairing generation a draft open should be checked against, captured
   * *before* the open is awaited. Reading it after the await would always match
   * and prove nothing.
   */
  epoch(): number {
    return this.generation;
  }

  /**
   * Whether an epoch captured before an await is still the current one.
   *
   * Callers must act on a true answer without awaiting first: the check and the
   * registration it guards are only atomic with respect to `forgetAll` if no
   * await separates them.
   */
  isCurrent(epoch: number): boolean {
    return epoch === this.generation;
  }

  get size(): number {
    return this.byKey.size;
  }

  private key(chatId: string, draftId: number): string {
    return `${chatId}:${draftId}`;
  }
}
