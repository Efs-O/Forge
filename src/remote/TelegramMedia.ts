import * as fsp from 'fs/promises';
import * as path from 'path';
import { sliceCodePoints } from '../util/codePoints';
import { MAX_FILE_DELIVERY_BYTES } from '../util/fileDeliveryValidation';
import type { TelegramChatQueue } from './telegramSendQueue';

type Fetch = typeof fetch;
type MediaMethod = 'sendVideo' | 'sendAudio' | 'sendDocument';

const MAX_CAPTION_CHARS = 1_024;
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
};

export function sendTelegramVideo(
  fetchImpl: Fetch,
  token: string,
  queue: TelegramChatQueue,
  chatId: string,
  filePath: string,
  caption: string,
  signal?: AbortSignal,
): Promise<void> {
  return sendTelegramMedia(fetchImpl, token, queue, 'sendVideo', chatId, filePath, caption, signal);
}

export function sendTelegramAudio(
  fetchImpl: Fetch,
  token: string,
  queue: TelegramChatQueue,
  chatId: string,
  filePath: string,
  caption: string,
  signal?: AbortSignal,
): Promise<void> {
  return sendTelegramMedia(fetchImpl, token, queue, 'sendAudio', chatId, filePath, caption, signal);
}

export function sendTelegramDocument(
  fetchImpl: Fetch,
  token: string,
  queue: TelegramChatQueue,
  chatId: string,
  filePath: string,
  caption: string,
  signal?: AbortSignal,
): Promise<void> {
  return sendTelegramMedia(
    fetchImpl,
    token,
    queue,
    'sendDocument',
    chatId,
    filePath,
    caption,
    signal,
  );
}

async function sendTelegramMedia(
  fetchImpl: Fetch,
  token: string,
  queue: TelegramChatQueue,
  method: MediaMethod,
  chatId: string,
  filePath: string,
  caption: string,
  signal?: AbortSignal,
): Promise<void> {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size === 0)
    throw new Error('Telegram media must be a non-empty file.');
  if (stat.size > MAX_FILE_DELIVERY_BYTES) {
    throw new Error(`Telegram media exceeds its ${MAX_FILE_DELIVERY_BYTES}-byte upload limit.`);
  }
  const bytes = await fsp.readFile(filePath);
  const name = path.basename(filePath);
  const type =
    MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const post = async (target: MediaMethod): Promise<Response> => {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', sliceCodePoints(caption, MAX_CAPTION_CHARS));
    const field = target === 'sendVideo' ? 'video' : target === 'sendAudio' ? 'audio' : 'document';
    form.append(field, new Blob([new Uint8Array(bytes)], { type }), name);
    return fetchImpl(`https://api.telegram.org/bot${token}/${target}`, {
      method: 'POST',
      body: form,
      ...(signal ? { signal } : {}),
    });
  };
  await queue.run(chatId, async () => {
    const response = await post(method);
    if (response.ok) return;
    if (method === 'sendDocument' || response.status !== 400) {
      throw new Error(`Telegram ${method} HTTP ${response.status}.`);
    }
    const fallback = await post('sendDocument');
    if (!fallback.ok) throw new Error(`Telegram sendDocument HTTP ${fallback.status}.`);
  });
}
