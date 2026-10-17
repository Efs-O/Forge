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
  | {
      kind: 'plain';
      messageId: string;
      stopButtonOnStatus: boolean;
      stopMessageId?: string;
      error?: string;
    }
  | { kind: 'declined'; error?: string | undefined };

/** The slice of a transport the opener needs. */
export interface ProgressCapableChannel {
  sendProgress?(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal; stopButton?: boolean },
  ): Promise<string | undefined>;
  sendProgressStopControl?(
    chatId: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
  clearInlineKeyboard?(chatId: string, messageId: string): Promise<void>;
}

/** Remove the standalone Stop row, falling back to leaving only inert text. */
export async function removeProgressStopControl(
  channel: ProgressCapableChannel,
  chatId: string,
  messageId: string,
): Promise<void> {
  let deletionError: unknown;
  if (channel.deleteMessage) {
    try {
      await channel.deleteMessage(chatId, messageId);
      return;
    } catch (err) {
      deletionError = err;
    }
  }
  if (channel.clearInlineKeyboard) {
    try {
      await channel.clearInlineKeyboard(chatId, messageId);
      return;
    } catch (err) {
      throw new Error(
        `could not delete or disable the Telegram Stop row: ${String(err)}${
          deletionError ? ` (delete failed: ${String(deletionError)})` : ''
        }`,
      );
    }
  }
  if (deletionError) throw deletionError;
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
  let stopMessageId: string | undefined;
  let stopButtonOnStatus = true;
  let error: string | undefined;
  if (channel.sendProgressStopControl) {
    try {
      stopMessageId = await channel.sendProgressStopControl(chatId, { signal });
      stopButtonOnStatus = !stopMessageId;
      if (!stopMessageId) error = 'Stop control could not be opened: no message id was returned';
    } catch (err) {
      // Still open the status with its original inline Stop button if the
      // separate Telegram control row could not be created.
      error = `Stop control could not be opened: ${describeError(err)}`;
    }
  }
  try {
    const messageId = await channel.sendProgress(chatId, text, {
      signal,
      stopButton: stopButtonOnStatus,
    });
    if (!messageId) {
      if (stopMessageId) {
        try {
          await removeProgressStopControl(channel, chatId, stopMessageId);
        } catch (cleanupError) {
          error = `Stop control cleanup failed: ${describeError(cleanupError)}`;
        }
      }
      return { kind: 'declined', ...(error ? { error } : {}) };
    }
    return {
      kind: 'plain',
      messageId,
      stopButtonOnStatus,
      ...(stopMessageId ? { stopMessageId } : {}),
      ...(error ? { error } : {}),
    };
  } catch (err) {
    const openingError = describeError(err);
    if (stopMessageId) {
      try {
        await removeProgressStopControl(channel, chatId, stopMessageId);
      } catch (cleanupError) {
        return {
          kind: 'declined',
          error: `${openingError}; Stop control cleanup failed: ${describeError(cleanupError)}`,
        };
      }
    }
    return { kind: 'declined', error: error ? `${error}; ${openingError}` : openingError };
  }
}
