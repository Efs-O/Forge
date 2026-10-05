/**
 * The ⏹ Stop button under a turn's status bubble.
 *
 * It replaced the words preview's native Stop (`can_stop`), which swapped the
 * chat's Send button for Stop whenever a preview was live. This one stays on
 * the bubble for the whole turn, tool calls included. The callback carries no
 * id: the tapped message is the bubble, and the bubble names the turn.
 */
const STOP_CALLBACK_DATA = 'x';

/** `reply_markup` for a bubble send or edit; empty when the button is off. */
export function telegramStopKeyboard(options?: { stopButton?: boolean }): {
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
} {
  if (!options?.stopButton) return {};
  return {
    reply_markup: { inline_keyboard: [[{ text: '⏹ Stop', callback_data: STOP_CALLBACK_DATA }]] },
  };
}

export function isTelegramStopCallback(data: string): boolean {
  return data === STOP_CALLBACK_DATA;
}
