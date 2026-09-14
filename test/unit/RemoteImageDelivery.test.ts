import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import { sendTelegramPhoto, TELEGRAM_MAX_PHOTO_BYTES } from '../../src/remote/TelegramPhoto';
import { TelegramChatQueue } from '../../src/remote/telegramSendQueue';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';

afterEach(() => {
  vi.useRealTimers();
});

function progressRig(canDeliver = true) {
  const channel = new FakeRemoteChannel();
  const progress = new RemoteAgentProgress(
    channel,
    new AbortController().signal,
    () => canDeliver,
    3_900,
    1_000,
  );
  return { channel, progress };
}

describe('RemoteAgentProgress.deliverImage', () => {
  it('reports 0 and sends nothing when no message is watching the turn', async () => {
    const { channel, progress } = progressRig();
    expect(progress.deliverImage('c1', 'C:/img/fox.jpg', 'fox')).toBe(0);
    await Promise.resolve();
    expect(channel.photos).toEqual([]);
  });

  it('sends the photo to the watching chat, after the narration that preceded it', async () => {
    vi.useFakeTimers();
    const { channel, progress } = progressRig();
    const order: string[] = [];
    const send = channel.send.bind(channel);
    channel.send = async (chatId, text, options) => {
      order.push(`text:${text}`);
      await send(chatId, text, options);
    };
    const sendPhoto = channel.sendPhoto.bind(channel);
    channel.sendPhoto = async (chatId, filePath, caption) => {
      order.push(`photo:${caption}`);
      await sendPhoto(chatId, filePath, caption);
    };
    progress.begin('c1', 'chat-a', 'message-1');

    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Drawing the fox now.' });
    expect(progress.deliverImage('c1', 'C:/img/fox.jpg', '🖼 grok-imagine: fox')).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(order).toEqual(['text:Drawing the fox now.', 'photo:🖼 grok-imagine: fox']);
    expect(channel.photos).toEqual([
      { chatId: 'chat-a', filePath: 'C:/img/fox.jpg', caption: '🖼 grok-imagine: fox' },
    ]);
  });

  it('does not send to a chat that may not receive deliveries', async () => {
    vi.useFakeTimers();
    const { channel, progress } = progressRig(false);
    progress.begin('c1', 'chat-a', 'message-1');
    progress.deliverImage('c1', 'C:/img/fox.jpg', 'fox');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.photos).toEqual([]);
  });
});

describe('UserNotificationService.deliverImage', () => {
  it('does not spend the notify_user burst budget', async () => {
    const notifications = new UserNotificationService();
    notifications.addSink(async () => 1);
    for (let index = 0; index < 8; index += 1) {
      await notifications.deliverImage({ conversationId: 'c1', text: 'img', imagePath: 'a.png' });
    }
    expect(notifications.remaining('c1')).toBe(5);
  });
});

describe('sendTelegramPhoto', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function imageFile(bytes: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tg-photo-'));
    dirs.push(dir);
    const file = path.join(dir, 'fox.jpg');
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    return file;
  }

  function recordingFetch(statuses: Record<string, number>) {
    const methods: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const method = String(url).split('/').pop() ?? '';
      methods.push(method);
      return new Response('{}', { status: statuses[method] ?? 200 });
    }) as unknown as typeof fetch;
    return { methods, fetchImpl };
  }

  it('sends a photo when Telegram accepts it', async () => {
    const { methods, fetchImpl } = recordingFetch({});
    await sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', imageFile(10), 'fox');
    expect(methods).toEqual(['sendPhoto']);
  });

  it('falls back to a document when sendPhoto rejects the image', async () => {
    const { methods, fetchImpl } = recordingFetch({ sendPhoto: 400 });
    await sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', imageFile(10), 'fox');
    expect(methods).toEqual(['sendPhoto', 'sendDocument']);
  });

  it('goes straight to a document above the photo size limit', async () => {
    const { methods, fetchImpl } = recordingFetch({});
    const big = imageFile(TELEGRAM_MAX_PHOTO_BYTES + 1);
    await sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', big, 'fox');
    expect(methods).toEqual(['sendDocument']);
  });

  it('throws on a non-400 failure instead of retrying as a document', async () => {
    const { methods, fetchImpl } = recordingFetch({ sendPhoto: 401 });
    await expect(
      sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', imageFile(10), 'fox'),
    ).rejects.toThrow(/sendPhoto HTTP 401/);
    expect(methods).toEqual(['sendPhoto']);
  });
});
