/**
 * Legacy Stop callbacks for messages sent before the reply keyboard. `x` is
 * the inline fallback on a status message; `y` is the old Telegram control row.
 * The tapped message id maps back to the active turn, so no turn id is needed.
 */
const STOP_CALLBACK_DATA = 'x';
const CONTROL_CALLBACK_DATA = 'y';
export const STOP_KEY_LABEL = '⏹ Stop';

/** Reply-keyboard markup shared by prompt and standalone control carriers. */
export function telegramStopReplyKeyboard(): {
  keyboard: { text: string }[][];
  resize_keyboard: true;
  is_persistent: true;
  input_field_placeholder: string;
} {
  return {
    keyboard: [[{ text: STOP_KEY_LABEL }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Forge is working — tap Stop to cancel',
  };
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
