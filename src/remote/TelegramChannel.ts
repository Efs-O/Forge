import { z } from 'zod';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      text: z.string().optional(),
      chat: z.object({ id: z.union([z.number(), z.string()]), type: z.string() }),
      from: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      from: z.object({ id: z.union([z.number(), z.string()]) }),
      message: z
        .object({ chat: z.object({ id: z.union([z.number(), z.string()]), type: z.string() }) })
        .optional(),
    })
    .optional(),
});

const TelegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
});

type Fetch = typeof fetch;
const CURSOR_KEY = 'telegram:update-offset';
const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_BOT_TOKEN_SECRET = 'forge.remote.telegram.botToken';

export interface TelegramChannelOptions {
  token: string;
  getCursor: (key: string) => string | undefined;
  setCursor: (key: string, value: string) => Promise<void>;
  fetch?: Fetch;
}

/** Telegram Bot API long polling with disposition-before-cursor ordering. */
export class TelegramChannel implements RemoteChannel {
  readonly name = 'telegram' as const;
  private handler: ((event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>) | undefined;
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: TelegramChannelOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  onEvent(handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>): {
    dispose(): void;
  } {
    this.handler = handler;
    return { dispose: () => (this.handler = undefined) };
  }

  async start(signal: AbortSignal): Promise<void> {
    void this.poll(signal).catch(() => undefined);
  }

  async send(chatId: string, text: string, options?: { correlationId?: string }): Promise<void> {
    const chunks = splitTelegramText(text);
    for (let index = 0; index < chunks.length; index++) {
      const correlationId = index === 0 ? options?.correlationId : undefined;
      await this.call('sendMessage', {
        chat_id: chatId,
        text: chunks[index],
        ...(correlationId
          ? {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: 'Approve', callback_data: `a:${correlationId}` },
                    { text: 'Deny', callback_data: `d:${correlationId}` },
                  ],
                ],
              },
            }
          : {}),
      });
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let offset = Number(this.options.getCursor(CURSOR_KEY) ?? '0');
    if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
    while (!signal.aborted) {
      let updates: z.infer<typeof TelegramUpdateSchema>[];
      try {
        const result = await this.call(
          'getUpdates',
          {
            offset,
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
          },
          signal,
        );
        updates = z.array(TelegramUpdateSchema).parse(result);
      } catch {
        if (signal.aborted) return;
        await abortableDelay(1_000, signal);
        continue;
      }
      for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
        const event = this.toEvent(update);
        let disposition: RemoteInboundDisposition = { kind: 'handled' };
        if (event && this.handler) {
          try {
            disposition = await this.handler(event);
          } catch (err) {
            disposition = {
              kind: 'retry',
              reason: err instanceof Error ? err.message : String(err),
            };
          }
        }
        if (update.callback_query) {
          await this.call('answerCallbackQuery', {
            callback_query_id: update.callback_query.id,
            text: disposition.kind === 'rejected' ? disposition.reason.slice(0, 200) : 'Received',
          }).catch(() => undefined);
        }
        if (disposition.kind === 'retry') break;
        offset = update.update_id + 1;
        await this.options.setCursor(CURSOR_KEY, String(offset));
      }
    }
  }

  private toEvent(update: z.infer<typeof TelegramUpdateSchema>): RemoteInboundEvent | undefined {
    const message = update.message;
    if (message?.text !== undefined && message.from) {
      return {
        channel: 'telegram',
        kind: 'text',
        providerMessageId: String(message.message_id),
        senderId: String(message.from.id),
        chatId: String(message.chat.id),
        chatType: telegramChatType(message.chat.type),
        receivedAt: message.date * 1000,
        text: message.text,
      };
    }
    const callback = update.callback_query;
    const match = callback?.data ? /^([ad]):(.+)$/.exec(callback.data) : undefined;
    if (!callback || !callback.message || !match) return undefined;
    return {
      channel: 'telegram',
      kind: 'action',
      providerMessageId: callback.id,
      senderId: String(callback.from.id),
      chatId: String(callback.message.chat.id),
      chatType: telegramChatType(callback.message.chat.type),
      receivedAt: Date.now(),
      action: match[1] === 'a' ? 'approve' : 'deny',
      correlationId: match[2]!,
    };
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.options.token}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw new Error(`Telegram Bot API HTTP ${response.status}.`);
    const parsed = TelegramResponseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error(`Telegram Bot API rejected ${method}.`);
    return parsed.result;
  }
}

function telegramChatType(value: string): RemoteInboundEvent['chatType'] {
  if (value === 'private') return 'private';
  return value === 'channel' ? 'channel' : 'group';
}

export function splitTelegramText(text: string): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += TELEGRAM_TEXT_LIMIT) {
    chunks.push(text.slice(offset, offset + TELEGRAM_TEXT_LIMIT));
  }
  return chunks;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
