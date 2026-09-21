import { describe, expect, it, vi } from 'vitest';
import { handleRemoteSessionCommand } from '../../src/remote/RemoteSessionCommands';
import { TelegramChannel } from '../../src/remote/TelegramChannel';
import { telegramUpdateToEvent } from '../../src/remote/TelegramInboundMapping';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import type { RemoteInboundEvent, RemoteChannel } from '../../src/remote/types';

const event = {
  channel: 'telegram',
  kind: 'text',
  providerMessageId: 'help-command',
  senderId: 'owner',
  chatId: 'chat',
  chatType: 'private',
  receivedAt: 1,
  text: '/help',
} as Extract<RemoteInboundEvent, { kind: 'text' }>;

describe('RemoteHelpBridge', () => {
  it('renders help with a close button and deletes only the exact message', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          method: String(url).split('/').at(-1)!,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) } as Response;
      }) as typeof fetch,
    });

    await channel.sendHelp('chat', '<b>Forge commands:</b>', { parseMode: 'HTML' });

    const body = calls[0]?.body;
    const button = (
      body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
    ).inline_keyboard[0]?.[0];
    expect(body).toMatchObject({ parse_mode: 'HTML' });
    expect(button?.text).toBe('✕ Close');
    expect(button?.callback_data).toBe('h:x');

    const result = await channel.handleHelpAction!({
      channel: 'telegram',
      kind: 'help_action',
      providerMessageId: 'callback-1',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: 2,
      action: 'close',
      helpToken: 'x',
        messageId: '42',
    });
    expect(result).toEqual({ kind: 'handled' });
    expect(calls.at(-1)).toEqual({
      method: 'deleteMessage',
      body: { chat_id: 'chat', message_id: 42 },
    });
  });

  it('maps the Telegram close callback into the strict inbound event', () => {
    expect(
      telegramUpdateToEvent({
        update_id: 1,
        callback_query: {
          id: 'callback-1',
          data: 'h:x',
          from: { id: 7 },
          message: { message_id: 42, chat: { id: 9, type: 'private' } },
        },
      }),
    ).toMatchObject({
      kind: 'help_action',
      helpToken: 'x',
      action: 'close',
      messageId: '42',
    });
  });

  it('routes /help through the persistent surface instead of the auto-cleaned reply path', async () => {
    const channel = new FakeRemoteChannel('telegram');
    const sendHelp = vi.fn(async () => undefined);
    const context = {
      channel: { ...channel, sendHelp } as unknown as RemoteChannel,
      signal: new AbortController().signal,
    } as unknown as RemoteCommandContext;

    await handleRemoteSessionCommand('/help', undefined, event, context);

    expect(sendHelp).toHaveBeenCalledOnce();
    expect(sendHelp.mock.calls[0]?.[1]).toContain('<b>Forge commands:</b>');
    expect(channel.sent).toHaveLength(0);
  });
});
