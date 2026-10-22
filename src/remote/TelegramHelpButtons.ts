import type { RemoteContactButton } from './types';

export type TelegramHelpCallback =
  | { action: 'close' }
  | { action: 'menu' }
  | { action: 'section'; sectionKey: string };

export function telegramHelpButton(): RemoteContactButton {
  return { text: '✕ Close', callbackData: encodeHelpCallback('h:x') };
}

export function telegramHelpMenuButton(): RemoteContactButton {
  return { text: '‹ Sections', callbackData: encodeHelpCallback('h:m') };
}

export function telegramHelpSectionButton(key: string, text: string): RemoteContactButton {
  if (!/^[A-Za-z0-9_-]{1,8}$/.test(key)) {
    throw new Error('Forge Telegram help section key is invalid.');
  }
  return { text, callbackData: encodeHelpCallback(`h:s:${key}`) };
}

export function parseTelegramHelpCallback(data: string): TelegramHelpCallback | undefined {
  if (data === 'h:x') return { action: 'close' };
  if (data === 'h:m') return { action: 'menu' };
  const match = /^h:s:([A-Za-z0-9_-]{1,8})$/.exec(data);
  return match ? { action: 'section', sectionKey: match[1]! } : undefined;
}

function encodeHelpCallback(data: string): string {
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error('Forge Telegram help callback exceeds the Bot API limit.');
  }
  return data;
}
