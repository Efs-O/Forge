import { describeError } from '../util/describeError';

/**
 * What the progress lifecycle decided when it opened this turn's first bubble.
 *
 * The bubble is always a plain message edited in place, never a rich draft:
 * Telegram animates every change to a draft, so a status line that is rewritten
 * (a tool name, the clock) was re-typed letter by letter on every update. See
 * docs/plans/TELEGRAM_LIVE_BUBBLE_PLAN.md.
 */
export type ProgressOpen =
  | { kind: 'plain'; messageId: string }
  | { kind: 'declined'; error?: string | undefined };

/** The slice of a transport the opener needs. */
export interface ProgressCapableChannel {
  sendProgress?(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal; stopButton?: boolean },
  ): Promise<string | undefined>;
}

/**
 * Open one turn's first bubble.
 *
 * Shared by both openers (chat-queued drain and sidebar-started mirror) so they
 * cannot drift. Nothing here throws: the drain calls this *before* its
 * try/finally, so a failure escaping here would abandon a claimed request
 * without settling it, which is worse than having no progress bubble at all.
 */
export async function openProgressBubble(
  channel: ProgressCapableChannel,
  chatId: string,
  text: string,
  signal: AbortSignal,
): Promise<ProgressOpen> {
  if (!channel.sendProgress) return { kind: 'declined' };
  try {
    const messageId = await channel.sendProgress(chatId, text, { signal, stopButton: true });
    return messageId ? { kind: 'plain', messageId } : { kind: 'declined' };
  } catch (err) {
    return { kind: 'declined', error: describeError(err) };
  }
}
