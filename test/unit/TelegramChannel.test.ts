import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  splitTelegramText,
  TelegramChannel,
  TELEGRAM_BOT_COMMANDS,
} from '../../src/remote/TelegramChannel';
import {
  parseTelegramSelectionCallback,
  telegramSelectionKeyboard,
} from '../../src/remote/TelegramSelectionPagination';
import { RemoteAttachmentStore } from '../../src/remote/RemoteAttachmentStore';
import { HELP_TEXT } from '../../src/remote/remoteHelpText';
import type { RemoteInboundDisposition, RemoteInboundEvent } from '../../src/remote/types';

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

  /**
   * `HELP_TEXT` is the only place a phone user learns the image rules, so the
   * cap and the size limits must be spelled out there rather than discovered by
   * trial and error.
   */
  it('documents the 3-image album cap and the size limits in /help', () => {
    expect(HELP_TEXT).toContain('3 images');
    expect(HELP_TEXT).toContain('10 MiB');
    expect(HELP_TEXT).toContain('25 MiB');
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
    // The acknowledgement names the position it just assigned, so steering or
    // dropping it needs no second lookup — and no retyping of the prompt.
    await vi.waitFor(() => expect(acknowledgements[0]).toContain('/steer 2'));
    expect(acknowledgements[0]).toContain('/drop 2');
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

  it('sends explicitly requested rich text as Telegram HTML', async () => {
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

    await channel.sendHtml('chat', '<b><u>Forge backend: model</u></b>');
    expect(bodies[0]).toMatchObject({
      text: '<b><u>Forge backend: model</u></b>',
      parse_mode: 'HTML',
    });
  });

  it("rejects approval callback data beyond Telegram's 64-byte limit before sending", async () => {
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

  it('sends, edits, and deletes paginated selection messages', async () => {
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
        return response({ message_id: 42 });
      }) as typeof fetch,
    });
    const controls = {
      kind: 'conversations' as const,
      token: 'abcdefghijkl',
      page: 1,
      pageCount: 3,
    };

    await channel.selectionPages.send('chat', 'page two', controls);
    await channel.selectionPages.edit('chat', '42', 'page three', { ...controls, page: 2 });
    await channel.selectionPages.close('chat', '42');

    expect(calls.map((call) => call.method)).toEqual([
      'sendMessage',
      'editMessageText',
      'deleteMessage',
    ]);
    expect(calls[0]!.body).toMatchObject({
      chat_id: 'chat',
      text: 'page two',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '◀ Previous', callback_data: 's:abcdefghijkl:c:0' },
            { text: 'Next ▶', callback_data: 's:abcdefghijkl:c:2' },
          ],
          [{ text: '✕ Close', callback_data: 's:abcdefghijkl:c:x' }],
        ],
      },
    });
    expect(calls[1]!.body).toMatchObject({ message_id: 42, text: 'page three' });
    expect(calls[2]!.body).toEqual({ chat_id: 'chat', message_id: 42 });
  });

  it('deletes a message via the public deleteMessage affordance', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1)!;
        calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return response({ ok: true });
      }) as typeof fetch,
    });

    await channel.deleteMessage('chat', '42');
    expect(calls).toEqual([
      { method: 'deleteMessage', body: { chat_id: 'chat', message_id: 42 } },
    ]);
  });

  it('encodes and strictly parses selection callbacks within Telegram limits', () => {
    const keyboard = telegramSelectionKeyboard({
      kind: 'models',
      token: 'abcdefghijkl',
      page: 0,
      pageCount: 2,
    });
    const next = keyboard.inline_keyboard[0]![0]!.callback_data;
    const close = keyboard.inline_keyboard[1]![0]!.callback_data;
    expect(Buffer.byteLength(next, 'utf8')).toBeLessThanOrEqual(64);
    expect(parseTelegramSelectionCallback(next)).toEqual({
      kind: 'models',
      token: 'abcdefghijkl',
      action: 'show',
      page: 1,
    });
    expect(parseTelegramSelectionCallback(close)).toEqual({
      kind: 'models',
      token: 'abcdefghijkl',
      action: 'close',
    });
    expect(parseTelegramSelectionCallback('s:bad-token:m:1')).toBeUndefined();
    expect(parseTelegramSelectionCallback('a:approval')).toBeUndefined();
  });

  it('renders profile choices as selectable Telegram buttons', async () => {
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
        return response({ message_id: 42 });
      }) as typeof fetch,
    });
    const controls = { kind: 'models' as const, token: 'abcdefghijkl', page: 0, pageCount: 1 };

    await channel.selectionPages.sendChoices?.(
      'chat',
      'Choose profile',
      [
        { label: 'No profile', value: 0 },
        { label: '@audit', value: 1 },
      ],
      controls,
    );

    expect(calls[0]?.body).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: 'No profile', callback_data: 's:abcdefghijkl:m:p0' }],
          [{ text: '@audit', callback_data: 's:abcdefghijkl:m:p1' }],
          [{ text: '✕ Close', callback_data: 's:abcdefghijkl:m:x' }],
        ],
      },
    });
    expect(parseTelegramSelectionCallback('s:abcdefghijkl:m:p1')).toEqual({
      kind: 'models',
      token: 'abcdefghijkl',
      action: 'select',
      choice: 1,
    });
  });

  it('round-trips every selection kind, so a workspace page is not stamped as models', () => {
    for (const kind of ['conversations', 'models', 'workspaces'] as const) {
      const keyboard = telegramSelectionKeyboard({
        kind,
        token: 'abcdefghijkl',
        page: 1,
        pageCount: 3,
      });
      for (const button of keyboard.inline_keyboard.flat()) {
        expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
        expect(parseTelegramSelectionCallback(button.callback_data)?.kind).toBe(kind);
      }
    }
  });

  it('converts a Telegram selection callback into a strict remote event', async () => {
    const abort = new AbortController();
    const setCursor = vi.fn(async () => undefined);
    let delivered = false;
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        if (method === 'setMyCommands' || method === 'answerCallbackQuery') return response(true);
        if (method === 'getUpdates' && !delivered) {
          delivered = true;
          return response([
            {
              update_id: 77,
              callback_query: {
                id: 'callback-1',
                data: 's:abcdefghijkl:c:1',
                from: { id: 123 },
                message: { message_id: 42, chat: { id: 99, type: 'private' } },
              },
            },
          ]);
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }) as typeof fetch,
    });
    channel.onEvent(async (event) => {
      expect(event).toMatchObject({
        channel: 'telegram',
        kind: 'selection',
        providerMessageId: 'callback-1',
        senderId: '123',
        chatId: '99',
        selectionKind: 'conversations',
        selectionToken: 'abcdefghijkl',
        action: 'show',
        page: 1,
        messageId: '42',
      });
      abort.abort();
      return { kind: 'handled' };
    });

    await channel.start(abort.signal);
    await vi.waitFor(() => expect(setCursor).toHaveBeenCalledWith('telegram:update-offset', '78'));
  });

  /**
   * Before this mapping existed, a voice-only message matched none of the
   * text/document/photo conditions in `toEvent`, so it produced no event AND
   * still advanced the polling cursor -- the update was consumed and lost with
   * nothing logged. Silent drops are the worst failure shape available here.
   */
  it('maps a voice note to a voice event, with duration and reply id', async () => {
    const abort = new AbortController();
    let delivered = false;
    const seen: unknown[] = [];
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        if (method === 'setMyCommands') return response(true);
        if (method === 'getUpdates' && !delivered) {
          delivered = true;
          return response([
            {
              update_id: 91,
              message: {
                message_id: 5,
                date: 1_700_000_000,
                chat: { id: 99, type: 'private' },
                from: { id: 123 },
                voice: { file_id: 'voice-abc', duration: 3, mime_type: 'audio/ogg' },
                reply_to_message: { message_id: 4 },
              },
            },
          ]);
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }) as typeof fetch,
    });
    channel.onEvent(async (event) => {
      seen.push(event);
      abort.abort();
      return { kind: 'handled' };
    });

    await channel.start(abort.signal);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({
      channel: 'telegram',
      kind: 'voice',
      providerMessageId: '5',
      senderId: '123',
      chatId: '99',
      providerFileId: 'voice-abc',
      mediaType: 'audio/ogg',
      // Seconds on the wire, milliseconds on the event: the recording window
      // that correlates a spoken command is computed in ms (§22A R1-revised).
      durationMs: 3000,
      replyToMessageId: '4',
    });
  });

  /**
   * The reason a rejected voice note went nowhere has to reach the sender.
   *
   * `acknowledgeDisposition` used to run only for `text`, so every pre-transcription
   * rejection -- voice disabled in config, over the duration limit, oversize --
   * computed a perfectly good reason string and then dropped it. What the sender
   * experienced was a voice note vanishing into nothing, which is exactly what
   * Forge being offline looks like. A user who never wanted voice must be told
   * that, not left guessing.
   */
  it('tells the sender why a voice note was rejected', async () => {
    const abort = new AbortController();
    let delivered = false;
    const sent: Array<Record<string, unknown>> = [];
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        if (method === 'setMyCommands') return response(true);
        if (method === 'sendMessage') {
          sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          abort.abort();
          return response({ message_id: 7 });
        }
        if (method === 'getUpdates' && !delivered) {
          delivered = true;
          return response([
            {
              update_id: 92,
              message: {
                message_id: 6,
                date: 1_700_000_000,
                chat: { id: 99, type: 'private' },
                from: { id: 123 },
                voice: { file_id: 'voice-xyz', duration: 2, mime_type: 'audio/ogg' },
              },
            },
          ]);
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }) as typeof fetch,
    });
    channel.onEvent(async () => ({
      kind: 'rejected',
      reason: 'voice input is disabled (set voice.enabled in config)',
    }));

    await channel.start(abort.signal);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      chat_id: '99',
      text: 'Forge: voice input is disabled (set voice.enabled in config)',
    });
  });

  /**
   * Host errors are thrown with the prefix already attached (ForgeHostFacade
   * throws "Forge: conversation could not be restored."), and the rejection
   * acknowledgement added a second one, so a failed `/chat` read back as
   * "Forge: Forge: conversation could not be restored."
   */
  it('does not double the Forge prefix on a reason that already carries one', async () => {
    const abort = new AbortController();
    let delivered = false;
    const sent: Array<Record<string, unknown>> = [];
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        if (method === 'setMyCommands') return response(true);
        if (method === 'sendMessage') {
          sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          abort.abort();
          return response({ message_id: 8 });
        }
        if (method === 'getUpdates' && !delivered) {
          delivered = true;
          return response([
            {
              update_id: 93,
              message: {
                message_id: 9,
                date: 1_700_000_000,
                chat: { id: 99, type: 'private' },
                from: { id: 123 },
                text: '/chat d',
              },
            },
          ]);
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }) as typeof fetch,
    });
    channel.onEvent(async () => ({
      kind: 'rejected',
      reason: 'Forge: conversation could not be restored.',
    }));

    await channel.start(abort.signal);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      chat_id: '99',
      text: 'Forge: conversation could not be restored.',
    });
  });

  /**
   * `downloadAttachment` used to end `bytes.toString('utf8')` for anything that
   * was not an image or a PDF. Decoding arbitrary bytes as utf8 substitutes
   * U+FFFD for every invalid sequence, so the file arrived intact and left
   * corrupted -- with no error anywhere.
   */
  it('base64-encodes binary attachments instead of mangling them as utf8', async () => {
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f]);
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (url: string | URL | Request) => {
        if (String(url).endsWith('/getFile')) return response({ file_path: 'voice/a.oga' });
        return {
          ok: true,
          status: 200,
          // Buffer.from(array) is pool-allocated, so `.buffer` carries an
          // offset; copy it out or the test reads someone else's bytes.
          arrayBuffer: async () => new Uint8Array(binary).buffer,
        } as Response;
      }) as typeof fetch,
    });
    const result = await channel.downloadAttachment({
      name: 'a.oga',
      mediaType: 'audio/ogg',
      providerFileId: 'f1',
    });
    expect(Buffer.from(result.data!, 'base64')).toEqual(binary);
  });
});

describe('TelegramChannel retry bound', () => {
  it('gives up on an update that always throws instead of redelivering it forever', async () => {
    const abort = new AbortController();
    let cursor: string | undefined;
    let handled = 0;
    const sent: string[] = [];
    const update = {
      update_id: 7,
      message: {
        message_id: 1,
        chat: { id: 42, type: 'private' },
        from: { id: 42, is_bot: false },
        text: '/chat 1',
        date: 0,
      },
    };
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => cursor,
      setCursor: async (_key, value) => {
        cursor = value;
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1)!;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (method === 'setMyCommands') return response(true);
        if (method === 'sendMessage') {
          sent.push(String(body.text));
          return response({ message_id: 99 });
        }
        if (method === 'getUpdates') {
          // Telegram redelivers until the offset moves past the update.
          if (Number(body.offset ?? 0) > update.update_id) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            });
          }
          return response([update]);
        }
        return response(true);
      }) as typeof fetch,
    });

    channel.onEvent(async () => {
      handled += 1;
      throw new Error('conversation could not be restored');
    });
    await channel.start(abort.signal);
    await vi.waitFor(() => expect(cursor).toBe('8'));
    abort.abort();

    expect(handled).toBe(3);
    expect(sent.at(-1)).toContain('conversation could not be restored');
  });
});

/**
 * A Telegram photo album is delivered as separate `photo` updates sharing a
 * `media_group_id`. Without buffering, an album of N becomes N queued prompts.
 * These tests pin the merge: one batch of album photos is one multi-image event,
 * the cap is enforced with a notice, the offset advances per photo, and a
 * non-album message after an album is not dropped or reordered.
 */
describe('TelegramChannel photo albums', () => {
  function photoUpdate(
    updateId: number,
    messageId: number,
    fileId: string,
    groupId: string,
    text?: string,
  ) {
    return {
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: 99, type: 'private' },
        from: { id: 123 },
        photo: [{ file_id: fileId, file_size: 100 }],
        ...(groupId ? { media_group_id: groupId } : {}),
        ...(text ? { text } : {}),
      },
    };
  }

  function textUpdate(updateId: number, messageId: number, text: string) {
    return {
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: 99, type: 'private' },
        from: { id: 123 },
        text,
      },
    };
  }

  /**
   * Feeds `batches` one `getUpdates` result at a time (in order), returns one
   * empty result so a buffered album can settle, then hangs the long poll.
   * Captures the events the handler sees and every `sendMessage` body the
   * channel sends.
   */
  async function runAlbums(
    batches: unknown[][],
    handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>,
  ) {
    const abort = new AbortController();
    let poll = 0;
    let returnedEmpty = false;
    const events: RemoteInboundEvent[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const setCursor = vi.fn(async () => undefined);
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      setCursor,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1)!;
        if (method === 'setMyCommands') return response(true);
        if (method === 'sendMessage') {
          sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return response({ message_id: 1 });
        }
        if (method === 'getUpdates') {
          const batch = batches[poll++];
          if (batch !== undefined) return response(batch);
          if (!returnedEmpty) {
            returnedEmpty = true;
            return response([]);
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        }
        return response(true);
      }) as typeof fetch,
    });
    channel.onEvent(async (event) => {
      events.push(event);
      return handler(event);
    });
    await channel.start(abort.signal);
    return { abort, events, sent, setCursor };
  }

  it('maps a single non-album photo to one event (existing behaviour)', async () => {
    const h = await runAlbums([[photoUpdate(1, 1, 'f1', '')]], async () => ({
      kind: 'accepted',
      requestId: 'r',
    }));
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.abort.abort();
    expect(h.events[0]).toMatchObject({
      kind: 'text',
      providerMessageId: '1',
      attachments: [{ name: 'telegram-photo.jpg', mediaType: 'image/jpeg', providerFileId: 'f1' }],
    });
  });

  it('merges a 2-photo album in one batch into a single event', async () => {
    const h = await runAlbums(
      [[photoUpdate(1, 1, 'f1', 'g1'), photoUpdate(2, 2, 'f2', 'g1')]],
      async () => ({ kind: 'accepted', requestId: 'r' }),
    );
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.abort.abort();
    expect(h.events[0]).toMatchObject({
      kind: 'text',
      providerMessageId: '1',
      attachments: [{ providerFileId: 'f1' }, { providerFileId: 'f2' }],
    });
  });

  it('merges a 3-photo album into one event with no overflow notice', async () => {
    const h = await runAlbums(
      [
        [
          photoUpdate(1, 1, 'f1', 'g1'),
          photoUpdate(2, 2, 'f2', 'g1'),
          photoUpdate(3, 3, 'f3', 'g1'),
        ],
      ],
      async () => ({ kind: 'accepted', requestId: 'r' }),
    );
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.abort.abort();
    expect(h.events[0]).toMatchObject({
      kind: 'text',
      attachments: [{ providerFileId: 'f1' }, { providerFileId: 'f2' }, { providerFileId: 'f3' }],
    });
    expect(h.sent).toHaveLength(0);
  });

  it('caps a 4-photo album at 3 and tells the user the limit', async () => {
    const h = await runAlbums(
      [
        [
          photoUpdate(1, 1, 'f1', 'g1'),
          photoUpdate(2, 2, 'f2', 'g1'),
          photoUpdate(3, 3, 'f3', 'g1'),
          photoUpdate(4, 4, 'f4', 'g1'),
        ],
      ],
      async () => ({ kind: 'accepted', requestId: 'r' }),
    );
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.abort.abort();
    expect(h.events[0]).toMatchObject({
      kind: 'text',
      attachments: [{ providerFileId: 'f1' }, { providerFileId: 'f2' }, { providerFileId: 'f3' }],
    });
    expect(String(h.sent[0]!.text)).toContain('limited to 3 images');
    expect(String(h.sent[0]!.text)).toContain('10 MiB');
  });

  it('flushes an album before a following text message in the same batch', async () => {
    const h = await runAlbums(
      [[photoUpdate(1, 1, 'f1', 'g1'), photoUpdate(2, 2, 'f2', 'g1'), textUpdate(3, 3, 'after')]],
      async () => ({ kind: 'accepted', requestId: 'r' }),
    );
    await vi.waitFor(() => expect(h.events).toHaveLength(2));
    h.abort.abort();
    expect(h.events[0]).toMatchObject({
      kind: 'text',
      text: '',
      attachments: [{ providerFileId: 'f1' }, { providerFileId: 'f2' }],
    });
    expect(h.events[1]).toMatchObject({ kind: 'text', text: 'after' });
  });

  it('emits two events, in order, for two different albums in one batch', async () => {
    const h = await runAlbums(
      [
        [
          photoUpdate(1, 1, 'f1', 'gA'),
          photoUpdate(2, 2, 'f2', 'gA'),
          photoUpdate(3, 3, 'f3', 'gB'),
        ],
      ],
      async () => ({ kind: 'accepted', requestId: 'r' }),
    );
    await vi.waitFor(() => expect(h.events).toHaveLength(2));
    h.abort.abort();
    expect(h.events[0]).toMatchObject({
      kind: 'text',
      providerMessageId: '1',
      attachments: [{ providerFileId: 'f1' }, { providerFileId: 'f2' }],
    });
    expect(h.events[1]).toMatchObject({
      kind: 'text',
      providerMessageId: '3',
      attachments: [{ providerFileId: 'f3' }],
    });
  });

  it('commits the album offset after the combined event is handled', async () => {
    const h = await runAlbums(
      [
        [
          photoUpdate(1, 1, 'f1', 'g1'),
          photoUpdate(2, 2, 'f2', 'g1'),
          photoUpdate(3, 3, 'f3', 'g1'),
        ],
      ],
      async () => ({ kind: 'accepted', requestId: 'r' }),
    );
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.abort.abort();
    // The cursor commits only after the combined event is handled.
    expect(h.setCursor).toHaveBeenCalledTimes(1);
    expect(h.setCursor).toHaveBeenLastCalledWith('telegram:update-offset', '4');
  });

  it('merges an album split across poll batches', async () => {
    const h = await runAlbums(
      [
        [photoUpdate(1, 1, 'f1', 'g1'), photoUpdate(2, 2, 'f2', 'g1')],
        [photoUpdate(3, 3, 'f3', 'g1')],
      ],
      async () => ({ kind: 'accepted', requestId: 'r' }),
    );
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.abort.abort();
    expect(h.events[0]).toMatchObject({
      attachments: [{ providerFileId: 'f1' }, { providerFileId: 'f2' }, { providerFileId: 'f3' }],
    });
  });

  it('rejects an album after repeated handler failures before committing its cursor', async () => {
    const h = await runAlbums(
      [[photoUpdate(1, 1, 'f1', 'g1')]],
      async () => ({ kind: 'retry', reason: 'album handler failed' }),
    );
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.abort.abort();
    expect(h.events).toHaveLength(3);
    expect(h.sent[0]!.text).toContain('album handler failed');
    expect(h.setCursor).toHaveBeenLastCalledWith('telegram:update-offset', '2');
  });

  it('survives a cursor-commit failure: the album is delivered and the error is surfaced', async () => {
    const abort = new AbortController();
    const onError = vi.fn();
    const events: RemoteInboundEvent[] = [];
    let poll = 0;
    const channel = new TelegramChannel({
      token: 'secret-token',
      getCursor: () => undefined,
      // The durable cursor write fails. The album must still be handled and
      // acknowledged; the failure is reported, not thrown out of the poll loop.
      setCursor: async () => {
        throw new Error('cursor store unavailable');
      },
      onError,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1)!;
        if (method === 'setMyCommands') return response(true);
        if (method === 'getUpdates') {
          // One batch with a single album photo, then an empty response so the
          // buffered album flushes, then hang the long poll.
          const batch = poll;
          poll += 1;
          if (batch === 0) return response([photoUpdate(1, 1, 'f1', 'g1')]);
          if (batch === 1) return response([]);
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          });
        }
        return response(true);
      }) as typeof fetch,
    });
    channel.onEvent(async (event) => {
      events.push(event);
      return { kind: 'accepted', requestId: 'r' };
    });
    await channel.start(abort.signal);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    abort.abort();
    // The album was delivered despite the cursor failure...
    expect(events[0]).toMatchObject({ attachments: [{ providerFileId: 'f1' }] });
    // ...and the failure was reported to onError rather than escaping.
    expect(onError).toHaveBeenCalled();
    expect(String(onError.mock.calls[0]![0])).toContain('cursor commit failed');
  });
});

describe('RemoteAttachmentStore size limits', () => {
  it('rejects an image over the 10 MiB per-image limit', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-att-'));
    try {
      const store = new RemoteAttachmentStore(root);
      const oversize = Buffer.alloc(10 * 1024 * 1024 + 1);
      await expect(
        store.save('conv', 'req', [
          { name: 'big.jpg', mediaType: 'image/jpeg', data: oversize.toString('base64') },
        ]),
      ).rejects.toThrow('exceeds its 10 MiB limit');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
