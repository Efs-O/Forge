import { createHash } from 'crypto';
import type { RemoteContactButton } from './types';

export type TelegramJobAction = 'r' | 'p' | 'u' | 'c' | 'd' | 'D' | 'l';

export interface TelegramJobCallback {
  index: number;
  hash: string;
  action?: TelegramJobAction | undefined;
}

export function telegramJobHash(jobId: string): string {
  return createHash('sha1').update(jobId).digest('hex').slice(0, 8);
}

export function telegramJobCallback(
  index: number,
  jobId: string,
  action?: TelegramJobAction,
): string {
  if (!Number.isInteger(index) || index < 0 || index > 99_999_999) {
    throw new Error('Forge Telegram job index is invalid.');
  }
  const data = `j:${index}:${telegramJobHash(jobId)}${action ? `:${action}` : ''}`;
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error('Forge Telegram job callback exceeds the Bot API limit.');
  }
  return data;
}

export function telegramJobButton(
  text: string,
  index: number,
  jobId: string,
  action?: TelegramJobAction,
): RemoteContactButton {
  return { text, callbackData: telegramJobCallback(index, jobId, action) };
}

export function parseTelegramJobCallback(data: string): TelegramJobCallback | undefined {
  const match = /^j:(0|[1-9]\d{0,7}):([a-f0-9]{8})(?::([rpucdDl]))?$/.exec(data);
  if (!match) return undefined;
  return {
    index: Number(match[1]),
    hash: match[2]!,
    ...(match[3] ? { action: match[3] as TelegramJobAction } : {}),
  };
}
