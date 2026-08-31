import { describe, expect, it, vi } from 'vitest';
import {
  splitTelegramText,
  TelegramChannel,
  TELEGRAM_BOT_COMMANDS,
} from '../../src/remote/TelegramChannel';

function response(result: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) } as Response;
}

describe('TelegramChannel', () => {
  it('registers the supported command menu when polling starts', async () => {
    const abort = new AbortController();
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1)!;
        calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        if (method === 'setMyCommands') return response(true);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }) as typeof fetch,
    });

    await channel.start(abort.signal);
    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        method: 'setMyCommands',
        body: { commands: TELEGRAM_BOT_COMMANDS },
      }),
    );
    abort.abort();
  });

  it('validates Bot API authentication without exposing the token', async () => {
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request) => {
        expect(String(url)).toContain('/getMe');
        return response({ id: 1, username: 'forge_bot' });
      }) as typeof fetch,
    });
    await expect(channel.healthCheck()).resolves.toEqual({
      ok: true,
      detail: 'Bot API authentication succeeded.',
    });
  });

  it('advances the durable cursor only after an awaited handled disposition', async () => {
    const abort = new AbortController();
    let polls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/getUpdates') && polls++ === 0) {
        return response([
          {
            update_id: 41,
            message: {
              message_id: 7,
              date: 10,
              text: 'hello',
              chat: { id: 99, type: 'private' },
              from: { id: 123 },
            },
          },
        ]);
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const setCursor = vi.fn(async () => undefined);
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor,
      fetch: fetchMock as typeof fetch,
    });
    channel.onEvent(async (event) => {
      expect(event).toMatchObject({
        channel: 'telegram',
        kind: 'text',
        senderId: '123',
        chatId: '99',
        chatType: 'private',
        text: 'hello',
      });
      return { kind: 'accepted', requestId: 'request' };
    });
    await channel.start(abort.signal);
    await vi.waitFor(() => expect(setCursor).toHaveBeenCalledWith('telegram:update-offset', '42'));
    abort.abort();
  });

  it('leaves a retry update replayable', async () => {
    const abort = new AbortController();
    const fetchMock = vi.fn(async () =>
      response([
        {
          update_id: 5,
          message: {
            message_id: 1,
            date: 1,
            text: 'retry me',
            chat: { id: 2, type: 'private' },
            from: { id: 3 },
          },
        },
      ]),
    );
    const setCursor = vi.fn(async () => undefined);
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor,
      fetch: fetchMock as typeof fetch,
    });
    channel.onEvent(async () => {
      abort.abort();
      return { kind: 'retry', reason: 'disk unavailable' };
    });
    await channel.start(abort.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setCursor).not.toHaveBeenCalled();
  });

  it('tells a queued Telegram prompt how to steer the conversation', async () => {
    const abort = new AbortController();
    let firstPoll = true;
    const acknowledgements: string[] = [];
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        if (method === 'setMyCommands') return response(true);
        if (method === 'getUpdates' && firstPoll) {
          firstPoll = false;
          return response([
            {
              update_id: 9,
              message: {
                message_id: 4,
                date: 1,
                text: 'follow up',
                chat: { id: 2, type: 'private' },
                from: { id: 3 },
              },
            },
          ]);
        }
        if (method === 'sendMessage') {
          const body = JSON.parse(String(init?.body)) as { text: string };
          acknowledgements.push(body.text);
          abort.abort();
          return response({ message_id: 10 });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }) as typeof fetch,
    });
    channel.onEvent(async () => ({ kind: 'queued', requestId: 'r1', position: 2 }));

    await channel.start(abort.signal);
    await vi.waitFor(() => expect(acknowledgements[0]).toContain('/steer <prompt>'));
  });

  it('splits long messages and attaches approval callbacks only to the first chunk', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ message_id: 1 });
      }) as typeof fetch,
    });
    await channel.send('chat', 'x'.repeat(5000), { correlationId: 'approval-1' });
    expect(splitTelegramText('x'.repeat(5000)).map((chunk) => chunk.length)).toEqual([4096, 904]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('reply_markup');
    expect(bodies[1]).not.toHaveProperty('reply_markup');
  });

  it('keeps Unicode code points intact at the Telegram message boundary', () => {
    const chunks = splitTelegramText(`${'x'.repeat(4095)}😀tail`);
    expect(chunks).toEqual([`${'x'.repeat(4095)}😀`, 'tail']);
    expect(chunks.join('')).toBe(`${'x'.repeat(4095)}😀tail`);
  });

  it('rejects approval callback data beyond Telegram\'s 64-byte limit before sending', async () => {
    const fetchMock = vi.fn(async () => response({ message_id: 1 }));
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      channel.send('chat', 'approval', { correlationId: 'x'.repeat(63) }),
    ).rejects.toThrow('approval identifier exceeds');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
