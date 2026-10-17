/**
 * Stop callbacks for live progress. `x` is the inline fallback on the status
 * message; `y` is the Telegram-only separate control row. The tapped message
 * id maps back to the active turn, so callback data needs no turn identifier.
 */
const STOP_CALLBACK_DATA = 'x';
const CONTROL_CALLBACK_DATA = 'y';

/** `reply_markup` for a bubble send or edit; empty when the button is off. */
export function telegramStopKeyboard(options?: { stopButton?: boolean; control?: boolean }): {
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
} {
  if (!options?.stopButton) return {};
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '⏹ Stop',
            callback_data: options.control ? CONTROL_CALLBACK_DATA : STOP_CALLBACK_DATA,
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
