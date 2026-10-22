import type { RemoteContactButton } from './types';

export const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

/** Build the Bot API keyboard while enforcing its callback payload limit. */
export function inlineKeyboardMarkup(buttons: readonly RemoteContactButton[][]): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => {
        if (Buffer.byteLength(button.callbackData, 'utf8') > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
          throw new Error('Forge Telegram callback identifier exceeds the Bot API limit.');
        }
        return { text: button.text, callback_data: button.callbackData };
      }),
    ),
  };
}
