export interface TelegramHelpCallback {
  token: 'x';
}

export function telegramHelpButton(): { text: string; callbackData: string } {
  const callbackData = 'h:x';
  if (Buffer.byteLength(callbackData, 'utf8') > 64) {
    throw new Error('Forge Telegram help callback exceeds the Bot API limit.');
  }
  return { text: '✕ Close', callbackData };
}

export function parseTelegramHelpCallback(data: string): TelegramHelpCallback | undefined {
  return data === 'h:x' ? { token: 'x' } : undefined;
}
