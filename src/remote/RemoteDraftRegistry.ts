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

  /** Drops every entry for a chat, used when a chat is unpaired or reset. */
  forgetChat(chatId: string): void {
    for (const [key, draft] of this.byKey) {
      if (draft.chatId === chatId) this.byKey.delete(key);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  private key(chatId: string, draftId: number): string {
    return `${chatId}:${draftId}`;
  }
}
