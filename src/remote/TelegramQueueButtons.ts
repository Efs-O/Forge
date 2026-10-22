import type { RemoteContactButton } from './types';

export type TelegramQueueCallback = { kind: 'all' } | { kind: 'one'; requestId: string };

export function telegramQueueButton(text: string, requestId: string | 'all'): RemoteContactButton {
  const callbackData = telegramQueueCallback(requestId);
  return { text, callbackData };
}

export function telegramQueueCallback(requestId: string | 'all'): string {
  if (requestId !== 'all' && !/^[A-Za-z0-9._~-]{1,60}$/.test(requestId)) {
    throw new Error('Forge Telegram queue request id is invalid.');
  }
  const data = requestId === 'all' ? 'q:all' : `q:${requestId}`;
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error('Forge Telegram queue callback exceeds the Bot API limit.');
  }
  return data;
}

export function parseTelegramQueueCallback(data: string): TelegramQueueCallback | undefined {
  if (data === 'q:all') return { kind: 'all' };
  const match = /^q:([A-Za-z0-9._~-]{1,60})$/.exec(data);
  return match ? { kind: 'one', requestId: match[1]! } : undefined;
}
