/**
 * Which approvals each chat has already given up on, and what its next call gets.
 *
 * Split out of `ToolApprovalService.ts`, which crossed ESLint's 500-line stop when
 * phase 4's flagged-exit rule arrived. One concern, no queue: once an approval in a
 * chat has gone unanswered, a later call that needs THE SAME approval resolves as
 * the same timeout rather than opening a new card, because nobody is answering
 * cards in this window and a second wait would stop the run for exactly the reason
 * the first did.
 *
 * It used to be one mark per chat, which made that promise outstrip its meaning:
 * an ignored `schedule_wake` card silenced every later approval in the turn, so
 * `manage_jobs create` came back `Not run` with a card the owner never saw
 * (2026-11-13 lab, rep 21). The mark is now per approval key — the same key the
 * card offered to allow, or the tool name when the card had no key — so ignoring
 * one thing stops that thing and nothing else. The queue stays the service's own;
 * this is only the turn-local memory of what happened, dropped at the start of the
 * next turn and when the chat closes.
 */
export class ApprovalTimeoutState {
  /** chat id → the approval keys that went unanswered, each with the minutes it waited. */
  private readonly timedOut = new Map<string, Map<string, number>>();

  /** Start a user turn: that chat may wait for a card again. */
  beginTurn(conversationId: string): void {
    this.timedOut.delete(conversationId);
  }

  /** Drop the state when a conversation is closed or deleted. */
  clear(conversationId: string): void {
    this.timedOut.delete(conversationId);
  }

  /** A chat already gave this approval a chance: its next call gets that timeout, not a card. */
  timedOutResult(
    conversationId: string,
    carryKey: string,
  ): { kind: 'timeout'; minutes: number; carried: true } | undefined {
    const minutes = this.timedOut.get(conversationId)?.get(carryKey);
    return minutes === undefined ? undefined : { kind: 'timeout', minutes, carried: true };
  }

  /** Record the timeout for this one approval, so a later call needing it does not
   *  wait twice. A call needing a DIFFERENT approval still gets its own card. */
  record(conversationId: string, carryKey: string, minutes: number): void {
    let keys = this.timedOut.get(conversationId);
    if (!keys) {
      keys = new Map();
      this.timedOut.set(conversationId, keys);
    }
    keys.set(carryKey, minutes);
  }

  clearAll(): void {
    this.timedOut.clear();
  }
}
