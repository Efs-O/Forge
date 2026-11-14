/**
 * The gap between one Forge bubble and the one above it on the phone.
 *
 * Telegram draws consecutive messages from one bot with no space between them,
 * so a run of notices, mid-turn tells and status lines reads as one wall of
 * text. The gap is a first line that renders empty, which puts a clear line
 * between any two of them.
 *
 * The line holds U+2800, the same Braille blank `widenForStopButton` pads with:
 * Telegram trims an ordinary blank first line (and plain spaces) the way it
 * trims any leading whitespace, so a real newline alone would vanish.
 *
 * Display only, like `styleTelegramNotice`: the outbox, the audit log and
 * speech all keep the plain text. One constant here is the whole knob — widen
 * or drop the gap there, and every bubble follows.
 */
import { WIDE_BLANK } from './TelegramStopButton';

/** One untrimmable empty line; the body starts just below it. */
const GAP = `${WIDE_BLANK}\n`;

/** Code points to reserve when splitting, so the gap cannot push a bubble over. */
export const BUBBLE_GAP_CHARS = [...GAP].length;

/**
 * Prefix `text` with the gap. Idempotent: a leading blank line — including one
 * this function added — is replaced, never stacked, so editing a live bubble a
 * hundred times leaves exactly one gap.
 */
export function withTelegramBubbleGap(text: string): string {
  return `${GAP}${text.replace(/^(?:[ \t\u00A0\u2800]*\r?\n)+/u, '')}`;
}
