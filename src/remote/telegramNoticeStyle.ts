/**
 * How a Forge-authored notice looks in Telegram: an emoji for its kind, inside
 * a blockquote so the accent bar sets it apart from the agent's own replies.
 *
 * Applied at delivery only. The outbox, the audit log and speech all keep the
 * plain text; this changes nothing but what the chat renders.
 */
import { escapeTelegramHtml } from './telegramHtml';

/** Telegram's per-message limit; a styled notice that would split is sent plain. */
const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Whole-prefix match: a notice is text Forge wrote, never a reply that mentions Forge. */
const NOTICE_PREFIX = /^(?:Forge(?:[ :]|$)|Seen by the running turn\.)/u;

/** First match wins, tested against the notice's first line. */
const KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Seen by the running turn\./u, '👀'],
  [/^Forge asks:/u, '❓'],
  [/^Forge approval approved /u, '✅'],
  [/^Forge approval denied /u, '🚫'],
  [/^Forge approval\b/u, '🔔'],
  [/\b(?:failed|error|could not|cannot|refused)\b/iu, '⚠️'],
  [/\b(?:cancelled|denied|dismissed|discarded|dropped)\b/iu, '🚫'],
  [/\b(?:completed?|approved|answered|done|linked|unlocked)\b/iu, '✅'],
];
const DEFAULT_EMOJI = 'ℹ️';

export function noticeEmoji(text: string): string | undefined {
  if (!NOTICE_PREFIX.test(text)) return undefined;
  const firstLine = text.split('\n', 1)[0] ?? '';
  return KINDS.find(([pattern]) => pattern.test(firstLine))?.[1] ?? DEFAULT_EMOJI;
}

/** The HTML to send instead of `text`, or undefined to send it as it is. */
export function styleTelegramNotice(text: string): string | undefined {
  const emoji = noticeEmoji(text);
  if (!emoji) return undefined;
  const html = `<blockquote>${emoji} ${escapeTelegramHtml(text)}</blockquote>`;
  return [...html].length <= TELEGRAM_MESSAGE_LIMIT ? html : undefined;
}
