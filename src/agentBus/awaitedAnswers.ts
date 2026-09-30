/**
 * Which agents Forge's turn is blocked on right now: a blocking
 * `ask_live_session` (no `notify_on_answer`) registers its target alias until
 * the answer, timeout or abort. While it waits, the turn makes no tool calls,
 * so a queued message from that same agent cannot be claimed mid-turn and runs
 * only after the answer, where it reads as the newer word. That is how a
 * withdrawn "redo" beat the answer that withdrew it. The `/agent/message` route
 * refuses such a message and points the sender at the reply instead.
 */
export class AwaitedAnswers {
  private readonly waits = new Map<string, { alias: string; id: string }>();

  /** Question `id` blocks the turn on `alias` until `wait` settles. */
  async during<T>(alias: string, id: string, wait: () => Promise<T>): Promise<T> {
    this.waits.set(id, { alias: alias.toLowerCase(), id });
    try {
      return await wait();
    } finally {
      this.waits.delete(id);
    }
  }

  /** The id of a question Forge is blocked on `alias` answering, if any. */
  pendingFor(alias: string): string | undefined {
    const wanted = alias.toLowerCase();
    for (const wait of this.waits.values()) if (wait.alias === wanted) return wait.id;
    return undefined;
  }
}

export const awaitedAnswers = new AwaitedAnswers();
