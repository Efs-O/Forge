/**
 * Telegram Stop: an inline button (`x`) on the newest status message. `y` is
 * the old control row, still honoured for messages already on a phone, and
 * `STOP_KEY_LABEL` doubles as the text of the retired 0.17.67 reply-keyboard
 * key, so a tap on a leftover key still stops the turn. The tapped message id
 * maps back to the active turn, so no turn id is needed.
 */
const STOP_CALLBACK_DATA = 'x';
const CONTROL_CALLBACK_DATA = 'y';
export const STOP_KEY_LABEL = '⏹ Stop';

const WIDE_BLANK = '\u2800';
/** Code points the last line is padded to; about a full phone-width bubble. */
const STOP_BUBBLE_MIN_WIDTH = 38;
const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * An inline keyboard is only as wide as its message bubble, so a short status
 * leaves a small Stop in the corner. Padding the last line with U+2800 (a
 * Braille blank Telegram does not trim) widens the bubble and so the button.
 * Plain spaces widened it only halfway; owner's pick from a live test, 0.17.69.
 */
export function widenForStopButton(text: string, options?: { stopButton?: boolean }): string {
  if (!options?.stopButton) return text;
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  const missing = STOP_BUBBLE_MIN_WIDTH - [...lastLine].length;
  if (missing <= 0) return text;
  const padded = text + WIDE_BLANK.repeat(missing);
  // Telegram counts UTF-16 units; never let padding push a message over.
  return padded.length <= TELEGRAM_TEXT_LIMIT ? padded : text;
}

export function telegramRemoveStopReplyKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}

/** `reply_markup` for a bubble send or edit; empty when the button is off. */
export function telegramStopKeyboard(options?: { stopButton?: boolean }): {
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
} {
  if (!options?.stopButton) return {};
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: STOP_KEY_LABEL,
            callback_data: STOP_CALLBACK_DATA,
          },
        ],
      ],
    },
  };
}

export function isTelegramStopCallback(data: string): boolean {
  return data === STOP_CALLBACK_DATA || data === CONTROL_CALLBACK_DATA;
}

export function isTelegramStopControlCallback(data: string): boolean {
  return data === CONTROL_CALLBACK_DATA;
}
