/**
 * Webview → host messages that act on a queued chip the running turn has not
 * read yet. A pair: both name the chip by the id the tell was queued under.
 */

/** Withdraws a mid-turn tell the running turn has not read yet. */
export interface CancelTellMsg {
  type: 'cancelTell';
  conversationId: string;
  tellId: string;
}

/**
 * "Send now": interrupts the running turn so the chip runs next. With a
 * `tellId` the host holds that tell for the next turn; without one (an
 * attachment chip, local to the webview) it only interrupts, and the webview's
 * end-of-turn flush sends the prompt.
 */
export interface SendQueuedNowMsg {
  type: 'sendQueuedNow';
  conversationId: string;
  tellId?: string;
}
