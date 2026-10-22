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
  sendProgressPrompt?(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  send?(chatId: string, text: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
  clearInlineKeyboard?(chatId: string, messageId: string): Promise<void>;
}

/** Delete a legacy Stop control row, falling back to leaving only inert text. */
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
  let promptSent = false;
  if (promptText) {
    try {
      // Silent where the transport can: it echoes the owner's own words.
      if (channel.sendProgressPrompt) {
        await channel.sendProgressPrompt(chatId, promptText, { signal });
      } else if (channel.send) {
        await channel.send(chatId, promptText, { signal });
      } else {
        return { kind: 'declined', error: 'This transport cannot send a mirrored prompt.' };
      }
      promptSent = true;
    } catch (err) {
      return {
        kind: 'declined',
        error: `Mirrored prompt could not be opened: ${describeError(err)}`,
      };
    }
  }
  try {
    // Stop rides inline on the status message (owner's call, 0.17.69): the
    // 0.17.67 reply-keyboard key sat where a swipe lands and got pressed.
    const messageId = await channel.sendProgress(chatId, text, { signal, stopButton: true });
    if (!messageId) return { kind: 'declined', ...(promptSent ? { promptSent: true } : {}) };
    return { kind: 'plain', messageId, ...(promptSent ? { promptSent: true } : {}) };
  } catch (err) {
    return {
      kind: 'declined',
      ...(promptSent ? { promptSent: true } : {}),
      error: describeError(err),
    };
  }
}
