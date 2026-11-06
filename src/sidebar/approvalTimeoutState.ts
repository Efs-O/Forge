/**
 * Which chats have a card that went unanswered, and what their next call gets.
 *
 * Split out of `ToolApprovalService.ts`, which crossed ESLint's 500-line stop when
 * phase 4's flagged-exit rule arrived. One concern, no queue: once a card in a chat
 * has gone unanswered, every later call in THAT chat resolves as the same timeout
 * rather than opening a new card, because nobody is answering cards in this window
 * and a second wait would stop the run for exactly the reason the first did. The
 * queue stays the service's own; this is only the turn-local memory of what
 * happened, dropped at the start of the next turn and when the chat closes.
 */
export class ApprovalTimeoutState {
  private readonly timedOut = new Set<string>();
  private readonly minutesById = new Map<string, number>();

  /** Start a user turn: that chat may wait for a card again. */
  beginTurn(conversationId: string): void {
    this.timedOut.delete(conversationId);
    this.minutesById.delete(conversationId);
  }

  /** Drop the state when a conversation is closed or deleted. */
  clear(conversationId: string): void {
    this.timedOut.delete(conversationId);
    this.minutesById.delete(conversationId);
  }

  /** A chat whose card went unanswered: its next call gets that timeout, not a card. */
  timedOutResult(
    conversationId: string,
  ): { kind: 'timeout'; minutes: number; carried: true } | undefined {
    if (!this.timedOut.has(conversationId)) return undefined;
    return { kind: 'timeout', minutes: this.minutesById.get(conversationId) ?? 0, carried: true };
  }

  /** Record the timeout, so later calls in this chat do not wait either. `set` and
   *  `add` always happen together: a chat marked timed out with no number stored
   *  would hand the caller `undefined` minutes and a message that says so. */
  record(conversationId: string, minutes: number): void {
    this.timedOut.add(conversationId);
    this.minutesById.set(conversationId, minutes);
  }

  clearAll(): void {
    this.timedOut.clear();
    this.minutesById.clear();
  }
}
