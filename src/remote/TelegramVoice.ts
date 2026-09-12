import * as fsp from 'fs/promises';
import type { TelegramChatQueue } from './telegramSendQueue';

type Fetch = typeof fetch;

export async function sendTelegramVoice(
  fetchImpl: Fetch,
  token: string,
  sendQueue: TelegramChatQueue,
  chatId: string,
  oggPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const bytes = await fsp.readFile(oggPath);
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('voice', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'reply.ogg');
  await sendQueue.run(chatId, async () => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendVoice`, {
      method: 'POST',
      body: form,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Telegram sendVoice HTTP ${response.status}.`);
  });
}
