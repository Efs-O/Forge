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
      stopMessageIsControl?: boolean;
      promptSent?: boolean;
      error?: string;
    }
  | { kind: 'declined'; locked?: boolean; promptSent?: boolean; error?: string | undefined };

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
  sendProgressPrompt?(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  send?(chatId: string, text: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  removeProgressStopKeyboard?(chatId: string): Promise<void>;
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
  clearInlineKeyboard?(chatId: string, messageId: string): Promise<void>;
}

/** Delete an obsolete Stop carrier, falling back to leaving only inert text. */
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
  canDeliver: () => Promise<boolean>,
  promptText?: string,
): Promise<ProgressOpen> {
  try {
    if (!(await canDeliver())) return { kind: 'declined', locked: true };
  } catch (err) {
    return { kind: 'declined', error: describeError(err) };
  }
  if (!channel.sendProgress) return { kind: 'declined' };
  let stopMessageId: string | undefined;
  let stopMessageIsControl = true;
  let stopButtonOnStatus = !channel.sendProgressStopControl;
  let promptSent = false;
  let error: string | undefined;
  if (promptText) {
    try {
      if (channel.sendProgressPrompt) {
        stopMessageId = await channel.sendProgressPrompt(chatId, promptText, { signal });
        promptSent = true;
        if (stopMessageId) {
          stopMessageIsControl = false;
          stopButtonOnStatus = false;
        } else {
          error = 'Mirrored prompt keyboard could not be opened: no message id was returned';
        }
      } else if (channel.send) {
        await channel.send(chatId, promptText, { signal });
        promptSent = true;
      } else {
        return { kind: 'declined', error: 'This transport cannot send a mirrored prompt.' };
      }
    } catch (err) {
      return {
        kind: 'declined',
        error: `Mirrored prompt could not be opened: ${describeError(err)}`,
      };
    }
  }
  if (!stopMessageId && channel.sendProgressStopControl) {
    try {
      stopMessageId = await channel.sendProgressStopControl(chatId, { signal });
      if (!stopMessageId) {
        error = 'Stop control could not be opened: no message id was returned';
        stopButtonOnStatus = true;
      }
    } catch (err) {
      error = `Stop control could not be opened: ${describeError(err)}`;
      stopButtonOnStatus = true;
    }
  }
  try {
    const messageId = await channel.sendProgress(chatId, text, {
      signal,
      stopButton: stopButtonOnStatus,
    });
    if (!messageId) {
      if (stopMessageId && stopMessageIsControl) {
        try {
          await removeProgressStopControl(channel, chatId, stopMessageId);
        } catch (cleanupError) {
          error = `Stop control cleanup failed: ${describeError(cleanupError)}`;
        }
      }
      if (stopMessageId && !stopMessageIsControl) {
        try {
          await channel.removeProgressStopKeyboard?.(chatId);
        } catch (cleanupError) {
          error = `Stop keyboard cleanup failed: ${describeError(cleanupError)}`;
        }
      }
      return {
        kind: 'declined',
        ...(promptSent ? { promptSent: true } : {}),
        ...(error ? { error } : {}),
      };
    }
    return {
      kind: 'plain',
      messageId,
      stopButtonOnStatus,
      ...(stopMessageId ? { stopMessageId } : {}),
      ...(stopMessageId ? { stopMessageIsControl } : {}),
      ...(promptSent ? { promptSent: true } : {}),
      ...(error ? { error } : {}),
    };
  } catch (err) {
    const openingError = describeError(err);
    if (stopMessageId && stopMessageIsControl) {
      try {
        await removeProgressStopControl(channel, chatId, stopMessageId);
      } catch (cleanupError) {
        return {
          kind: 'declined',
          ...(promptSent ? { promptSent: true } : {}),
          error: `${openingError}; Stop control cleanup failed: ${describeError(cleanupError)}`,
        };
      }
    }
    if (stopMessageId && !stopMessageIsControl) {
      try {
        await channel.removeProgressStopKeyboard?.(chatId);
      } catch (cleanupError) {
        return {
          kind: 'declined',
          ...(promptSent ? { promptSent: true } : {}),
          error: `${openingError}; Stop keyboard cleanup failed: ${describeError(cleanupError)}`,
        };
      }
    }
    return {
      kind: 'declined',
      ...(promptSent ? { promptSent: true } : {}),
      error: error ? `${error}; ${openingError}` : openingError,
    };
  }
}
