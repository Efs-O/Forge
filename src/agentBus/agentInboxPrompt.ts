/**
 * How a bus message reaches the chat as a prompt, and how its turn's end is
 * said back to the sender. The queue in `agentInbox.ts` owns ordering; this
 * module owns the two text shapes a delivery leaves behind: the age note on a
 * prompt that waited, and the one line that closes a turn.
 */

/** How a bus-started turn ended. `submit` resolving used to mean "finished",
 *  so a turn that was cancelled while queued behind a busy local server, or
 *  that failed, reached its sender as `finished` with no answer and no reason. */
export interface BusTurnEnd {
  kind: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** The failure, for `failed`. */
  error?: string;
  finalText?: string;
}

/** Waits shorter than this are ordinary queueing and say nothing. */
export const STALE_NOTE_AFTER_MS = 60_000;

/**
 * A bus message's prompt as delivered. One that sat in the queue gets its age
 * appended: a "redo 70K/120K" queued while Forge was blocked on a question
 * reached it after the sender's newer "no redo" reply, and with nothing
 * showing the order the agent read delivery order as authorship order and
 * started the withdrawn redo. The note sits after the agent-bus trailer, so
 * `parseForgeInboundPrompt` strips it from remote views.
 */
export function deliveredPrompt(
  item: Pick<{ prompt: string; from?: string; queuedAt: number }, 'prompt' | 'from' | 'queuedAt'>,
  now: number,
): string {
  const waited = now - item.queuedAt;
  if (!item.from || waited < STALE_NOTE_AFTER_MS) return item.prompt;
  const sent = new Date(item.queuedAt).toTimeString().slice(0, 8);
  const mins = Math.round(waited / 60_000);
  return (
    `${item.prompt}\n\n_(Queued: ${item.from} wrote this at ${sent}, ${mins} min before it ` +
    `reached you. Anything ${item.from} told you after that, including an answer to your ` +
    `question, is newer and overrides it.)_`
  );
}

/** The sender's one line for how its turn ended. Only `completed` says finished. */
export function busTurnEndLine(end: BusTurnEnd, durationMs: number): string {
  const took =
    durationMs < 60_000
      ? `${Math.max(1, Math.round(durationMs / 1000))} s`
      : `${Math.round(durationMs / 60_000)} min`;
  switch (end.kind) {
    case 'completed':
      return `finished · ${took} · the turn you started has ended`;
    case 'failed':
      return `failed · ${took} · the turn you started ended with an error: ${end.error ?? 'unknown error'}`;
    case 'cancelled':
      return `cancelled · ${took} · the turn you started was stopped before it answered`;
    case 'interrupted':
      return `interrupted · ${took} · the turn you started was interrupted before it answered`;
  }
}
