import * as fsp from 'fs/promises';
import * as path from 'path';
import { sliceCodePoints } from '../util/codePoints';
import type { TelegramChatQueue } from './telegramSendQueue';

type Fetch = typeof fetch;

/** Bot API ceiling for `sendPhoto`; anything larger can only go as a document. */
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Bot API caption limit. */
const MAX_CAPTION_CHARS = 1_024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};

/**
 * Deliver an image file, as a photo when Telegram will take it.
 *
 * `sendPhoto` recompresses and rejects some images outright -- over 10 MB, or
 * dimensions it will not accept (`PHOTO_INVALID_DIMENSIONS`). Those are sent
 * with `sendDocument` instead, which keeps the original bytes. The fallback is
 * one named retry on a 400, not a blanket catch: auth or network failures
 * still throw, so the caller reports them.
 */
export async function sendTelegramPhoto(
  fetchImpl: Fetch,
  token: string,
  sendQueue: TelegramChatQueue,
  chatId: string,
  filePath: string,
  caption: string,
  signal?: AbortSignal,
): Promise<void> {
  const bytes = await fsp.readFile(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
  // A non-image extension can never be accepted by sendPhoto, so attempting it
  // first is a guaranteed 400 and a wasted round trip on the chat queue. The
  // photo path itself is untouched for real images.
  const isImage = ext in MIME_BY_EXTENSION;
  const post = async (method: 'sendPhoto' | 'sendDocument'): Promise<Response> => {
    const form = new FormData();
    form.append('chat_id', chatId);
    // Trim in code points, not UTF-16 units: `.slice(0, 1024)` can cut an
    // emoji pair and send a lone surrogate, which arrives as U+FFFD. The
    // sender and `send_file`'s caption guard must count the same way
    // (audit F5, 2026-10-03).
    form.append('caption', sliceCodePoints(caption, MAX_CAPTION_CHARS));
    form.append(
      method === 'sendPhoto' ? 'photo' : 'document',
      new Blob([new Uint8Array(bytes)], { type }),
      name,
    );
    return fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      ...(signal ? { signal } : {}),
    });
  };
  await sendQueue.run(chatId, async () => {
    if (isImage && bytes.length <= TELEGRAM_MAX_PHOTO_BYTES) {
      const photo = await post('sendPhoto');
      if (photo.ok) return;
      if (photo.status !== 400) throw new Error(`Telegram sendPhoto HTTP ${photo.status}.`);
    }
    const document = await post('sendDocument');
    if (!document.ok) throw new Error(`Telegram sendDocument HTTP ${document.status}.`);
  });
}
