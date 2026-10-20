import { describe, expect, it, vi } from 'vitest';
import { acknowledgeTelegramDisposition } from '../../src/remote/TelegramAcknowledgement';
import { telegramUpdateToEvent } from '../../src/remote/TelegramInboundMapping';
import {
  parseTelegramSendNowCallback,
  TelegramSendNowReceipts,
} from '../../src/remote/TelegramSendNowButton';
import type { RemoteInboundEvent } from '../../src/remote/types';
import { RemoteInboundEventSchema } from '../../src/remote/remoteInboundSchema';

const REQUEST_ID = 'abcdef12-abcd-4abc-8def-abcdefabcdef';

describe('Telegram Send now receipt', () => {
  it('parses only bounded UUID callbacks and maps them to an authenticated action event', () => {
    expect(parseTelegramSendNowCallback(`n:${REQUEST_ID}`)).toBe(REQUEST_ID);
    expect(parseTelegramSendNowCallback(`n:${REQUEST_ID}x`)).toBeUndefined();
    expect(parseTelegramSendNowCallback(`n:${REQUEST_ID}${REQUEST_ID}`)).toBeUndefined();
    expect(parseTelegramSendNowCallback(`n:${REQUEST_ID.toUpperCase()}`)).toBeUndefined();
    const mapped = telegramUpdateToEvent({
      update_id: 1,
      callback_query: {
        id: 'callback',
        data: `n:${REQUEST_ID}`,
        from: { id: 42 },
        message: { message_id: 8, chat: { id: 99, type: 'private' } },
      },
    });
    expect(mapped).toMatchObject({
      kind: 'send_now_action',
      requestId: REQUEST_ID,
      chatId: '99',
      senderId: '42',
      messageId: '8',
    });
    expect(RemoteInboundEventSchema.safeParse(mapped).success).toBe(true);
  });

  it('uses a persistent button receipt without arming the short auto-delete', async () => {
    const send = vi.fn(async () => ['fallback']);
    const keyboard = vi.fn(async () => 'receipt');
    const ephemeral = vi.fn();
    const event: RemoteInboundEvent = {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: 'inbound',
      senderId: '42',
      chatId: '99',
      chatType: 'private',
      receivedAt: 1,
      text: 'run this',
    };
    await acknowledgeTelegramDisposition(
      event,
      { kind: 'queued', requestId: REQUEST_ID, position: 2 },
      new AbortController().signal,
      send,
      vi.fn(),
      ephemeral,
      keyboard,
    );
    expect(keyboard).toHaveBeenCalledWith(
      '99',
      expect.stringContaining('Send now stops the turn and runs it next.'),
      REQUEST_ID,
      expect.any(AbortSignal),
    );
    expect(send).not.toHaveBeenCalled();
    expect(ephemeral).not.toHaveBeenCalled();
  });

  it('falls back to the old ephemeral text receipt when a keyboard is unavailable', async () => {
    const send = vi.fn(async () => ['receipt']);
    const ephemeral = vi.fn();
    const event: RemoteInboundEvent = {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: 'inbound',
      senderId: '42',
      chatId: '99',
      chatType: 'private',
      receivedAt: 1,
      text: 'run this',
    };
    await acknowledgeTelegramDisposition(
      event,
      { kind: 'queued', requestId: REQUEST_ID, position: 1 },
      new AbortController().signal,
      send,
      vi.fn(),
      ephemeral,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(ephemeral).toHaveBeenCalledWith('99', ['receipt'], 'queued');
  });

  it('clears a receipt keyboard when deleting the receipt fails', async () => {
    const clear = vi.fn(async () => undefined);
    const receipts = new TelegramSendNowReceipts(
      vi.fn(async () => '12'),
      vi.fn(async () => {
        throw new Error('delete unavailable');
      }),
      clear,
    );
    await receipts.send('99', 'queued', REQUEST_ID);
    await receipts.retire(REQUEST_ID);
    expect(clear).toHaveBeenCalledWith('99', '12');
  });

  it('cleans the tapped message after restart when the in-memory registry is empty', async () => {
    const remove = vi.fn(async () => undefined);
    const receipts = new TelegramSendNowReceipts(
      vi.fn(async () => 'unused'),
      remove,
      vi.fn(),
    );
    await receipts.retireTapped(REQUEST_ID, '99', '77');
    expect(remove).toHaveBeenCalledWith('99', '77');
  });
});
