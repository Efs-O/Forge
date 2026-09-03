import * as fsp from 'fs/promises';
import { z } from 'zod';
import {
  isTextMediaType,
  mediaTypeForPath,
  TelegramUpdateSchema,
  telegramUpdateToEvent,
} from './TelegramInboundMapping';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { createTelegramSelectionPages } from './TelegramSelectionPagination';

const TelegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
});

type Fetch = typeof fetch;
const TelegramSentMessageSchema = z.object({ message_id: z.number().int() });

const CURSOR_KEY = 'telegram:update-offset';
/** Unanswered prompts are rare; this only bounds a pathological case. */
const PROMPT_MESSAGE_LIMIT = 256;
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;
export const TELEGRAM_BOT_TOKEN_SECRET = 'forge.remote.telegram.botToken';

/** Native Telegram command menu. Parsing remains transport-independent. */
export const TELEGRAM_BOT_COMMANDS = [
  { command: 'clanker', description: 'Set approval-gate mode' },
  { command: 'compact', description: 'Compact the conversation' },
  { command: 'context', description: 'Context usage and tokens' },
  { command: 'drop', description: 'Drop queued prompt or all' },
  { command: 'help', description: 'Show all Forge commands' },
  { command: 'list', description: 'List recent conversations' },
  { command: 'lock', description: 'Lock this remote session' },
  { command: 'model', description: 'Pin a model to this chat' },
  { command: 'models', description: 'List configured models' },
  { command: 'new', description: 'Start a new chat' },
  { command: 'notify', description: 'Agent notifications on/off' },
  { command: 'queue', description: 'List queued prompts' },
  { command: 'reload', description: 'Reload VS Code window' },
  { command: 'resume', description: 'Resume a conversation' },
  { command: 'restart', description: 'Restart the pinned model' },
  { command: 'status', description: 'Session, model, queue' },
  { command: 'steer', description: 'Interrupt and prioritize' },
  { command: 'stop', description: 'Stop the current request' },
  { command: 'timeout', description: 'Show/set session timeout' },
  { command: 'unload', description: 'Free memory: release the model' },
  { command: 'workspace', description: 'List workspaces and show where you are' },
] as const;

export interface TelegramChannelOptions {
  token: string;
  getCursor: (key: string) => string | undefined;
  setCursor: (key: string, value: string) => Promise<void>;
  fetch?: Fetch;
  onError?: (message: string) => void;
}

/** Telegram Bot API long polling with disposition-before-cursor ordering. */
export class TelegramChannel implements RemoteChannel {
  readonly name = 'telegram' as const;
  readonly selectionPages = createTelegramSelectionPages((method, body, signal) =>
    this.call(method, body, signal),
  );
  private handler: ((event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>) | undefined;
  private readonly fetchImpl: Fetch;
  /**
   * correlationId -> message_id of the prompt that carries its keyboard, so a
   * resolved approval can have its buttons removed. Bounded by
   * PROMPT_MESSAGE_LIMIT: an approval nobody ever answers would otherwise leak
   * an entry per prompt for the life of the window.
   */
  private readonly promptMessages = new Map<string, number>();

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
    void this.call('setMyCommands', { commands: TELEGRAM_BOT_COMMANDS }, signal).catch((err) => {
      if (!signal.aborted) {
        this.options.onError?.(
          `Forge Telegram command-menu registration failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
    void this.poll(signal).catch((err) => {
      if (!signal.aborted) {
        this.options.onError?.(
          `Forge Telegram polling stopped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  async send(
    chatId: string,
    text: string,
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<void> {
    const chunks = splitTelegramText(text);
    for (let index = 0; index < chunks.length; index++) {
      const correlationId = index === 0 ? options?.correlationId : undefined;
      const approveData = correlationId ? `a:${correlationId}` : undefined;
      const denyData = correlationId ? `d:${correlationId}` : undefined;
      if (
        (approveData &&
          Buffer.byteLength(approveData, 'utf8') > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) ||
        (denyData && Buffer.byteLength(denyData, 'utf8') > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES)
      ) {
        throw new Error('Forge Telegram approval identifier exceeds the Bot API limit.');
      }
      const sent = await this.call(
        'sendMessage',
        {
          chat_id: chatId,
          text: chunks[index],
          ...(correlationId
            ? {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: 'Approve', callback_data: approveData },
                      { text: 'Deny', callback_data: denyData },
                    ],
                  ],
                },
              }
            : {}),
        },
        options?.signal,
      );
      if (correlationId) this.rememberPrompt(correlationId, sent);
    }
  }

  async sendProgress(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined> {
    const sent = await this.call('sendMessage', { chat_id: chatId, text }, options?.signal);
    const parsed = TelegramSentMessageSchema.safeParse(sent);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.call(
      'editMessageText',
      { chat_id: chatId, message_id: Number(messageId), text },
      options?.signal,
    );
  }

  /**
   * Clears the inline keyboard, leaving the prompt text in place as the record
   * of what was asked. A prompt already edited, deleted, or unknown to this
   * process (a window reload drops the map) is not an error: there is nothing
   * left to retract, and failing here would surface as a spurious remote error.
   */
  async retractPrompt(chatId: string, correlationId: string, signal?: AbortSignal): Promise<void> {
    const messageId = this.promptMessages.get(correlationId);
    this.promptMessages.delete(correlationId);
    if (messageId === undefined) return;
    await this.call(
      'editMessageReplyMarkup',
      { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
      signal,
    ).catch(() => undefined);
  }

  private rememberPrompt(correlationId: string, sent: unknown): void {
    const parsed = TelegramSentMessageSchema.safeParse(sent);
    if (!parsed.success) return;
    if (this.promptMessages.size >= PROMPT_MESSAGE_LIMIT) {
      const oldest = this.promptMessages.keys().next();
      if (!oldest.done) this.promptMessages.delete(oldest.value);
    }
    this.promptMessages.set(correlationId, parsed.data.message_id);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      await this.call('getMe', {}, abort.signal);
      return { ok: true, detail: 'Bot API authentication succeeded.' };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let offset = Number(this.options.getCursor(CURSOR_KEY) ?? '0');
    let consecutiveFailures = 0;
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
        consecutiveFailures = 0;
      } catch (err) {
        if (signal.aborted) return;
        consecutiveFailures += 1;
        if (consecutiveFailures === 3) {
          this.options.onError?.(
            `Forge Telegram polling is retrying: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const delay = Math.min(1_000 * 2 ** Math.min(consecutiveFailures - 1, 5), 30_000);
        await abortableDelay(delay, signal);
        continue;
      }
      for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
        if (signal.aborted) return;
        const event = telegramUpdateToEvent(update);
        let disposition: RemoteInboundDisposition = event
          ? { kind: 'retry', reason: 'remote event handler is unavailable' }
          : { kind: 'handled' };
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
        if (event && (event.kind === 'text' || event.kind === 'voice')) {
          await this.acknowledgeDisposition(event, disposition, signal);
        }
        if (update.callback_query) {
          await this.call(
            'answerCallbackQuery',
            {
              callback_query_id: update.callback_query.id,
              text: disposition.kind === 'rejected' ? disposition.reason.slice(0, 200) : 'Received',
            },
            signal,
          ).catch(() => undefined);
        }
        if (disposition.kind === 'retry') break;
        offset = update.update_id + 1;
        await this.options.setCursor(CURSOR_KEY, String(offset));
      }
    }
  }

  async downloadAttachment(
    attachment: import('./types').RemoteInboundAttachment,
  ): Promise<import('./types').RemoteInboundAttachment> {
    if (!attachment.providerFileId) throw new Error('Telegram attachment has no file id.');
    const file = z
      .object({ file_path: z.string().min(1) })
      .parse(await this.call('getFile', { file_id: attachment.providerFileId }));
    const response = await this.fetchImpl(
      `https://api.telegram.org/file/bot${this.options.token}/${file.file_path}`,
    );
    if (!response.ok) throw new Error(`Telegram file download HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      ...attachment,
      // utf8 only for types that ARE text. Decoding arbitrary bytes as utf8
      // replaces every invalid sequence with U+FFFD, which silently corrupts the
      // file rather than failing -- audio, archives and office documents all
      // arrived intact and left unusable.
      data: isTextMediaType(attachment.mediaType)
        ? bytes.toString('utf8')
        : bytes.toString('base64'),
    };
  }

  /**
   * Streams a Telegram file to disk without it ever becoming a string (§9.2).
   *
   * Telegram's Bot API caps downloads at 20 MB, well under any voice note the
   * `voice.input.max_seconds` gate would allow through, so the whole body is
   * buffered once rather than piped -- a stream here would add a partial-file
   * failure mode for no benefit at this size.
   */
  async downloadAttachmentToFile(
    providerFileId: string,
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: number; mediaType: string }> {
    const file = z
      .object({ file_path: z.string().min(1) })
      .parse(await this.call('getFile', { file_id: providerFileId }, signal));
    const response = await this.fetchImpl(
      `https://api.telegram.org/file/bot${this.options.token}/${file.file_path}`,
    );
    if (!response.ok) throw new Error(`Telegram file download HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(targetPath, bytes);
    return { bytes: bytes.length, mediaType: mediaTypeForPath(file.file_path) };
  }

  /**
   * Says out loud why an inbound message went nowhere.
   *
   * Voice belongs here as much as text: a voice note rejected before
   * transcription -- voice disabled, over the duration limit, oversize -- had
   * its reason computed and then dropped, because this only ran for `text`. The
   * sender saw nothing at all, which is indistinguishable from Forge being
   * offline and is exactly the silent-failure shape the voice path is most
   * likely to be blamed for.
   */
  private async acknowledgeDisposition(
    event: Extract<RemoteInboundEvent, { kind: 'text' | 'voice' }>,
    disposition: RemoteInboundDisposition,
    signal: AbortSignal,
  ): Promise<void> {
    if (event.chatType !== 'private') return;
    let text: string | undefined;
    if (disposition.kind === 'queued') {
      text =
        event.kind === 'text' && event.text.trim().toLowerCase().startsWith('/steer')
          ? `Forge: steering prompt queued next (position ${disposition.position}).`
          : `Forge: queued at position ${disposition.position}. Use /steer <prompt> to interrupt the current turn and run a new instruction next, or /queue to review pending work.`;
    } else if (disposition.kind === 'rejected') {
      text = `Forge: ${disposition.reason}`;
    }
    if (!text) return;
    await this.send(event.chatId, text, { signal }).catch((err) => {
      if (!signal.aborted) {
        this.options.onError?.(
          `Forge Telegram acknowledgement failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }

  /**
   * Uploads a synthesized reply as a playable voice message.
   *
   * `sendVoice` rather than `sendAudio` because Telegram renders the former as
   * an inline waveform that plays on tap and the latter as a file with a
   * download step -- for a reply meant to just be heard, that is the feature.
   * It requires OGG/Opus specifically; see `encodeToOpus`.
   *
   * Multipart rather than `this.call`, which posts JSON: a file upload is the
   * one Bot API shape that cannot go through it.
   */
  async sendVoice(chatId: string, oggPath: string, signal?: AbortSignal): Promise<void> {
    const bytes = await fsp.readFile(oggPath);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('voice', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'reply.ogg');
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.options.token}/sendVoice`,
      { method: 'POST', body: form, ...(signal ? { signal } : {}) },
    );
    if (!response.ok) throw new Error(`Telegram sendVoice HTTP ${response.status}.`);
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

export function splitTelegramText(text: string): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  let chunk = '';
  let characters = 0;
  for (const character of text) {
    if (characters === TELEGRAM_TEXT_LIMIT) {
      chunks.push(chunk);
      chunk = '';
      characters = 0;
    }
    chunk += character;
    characters += 1;
  }
  if (chunk) chunks.push(chunk);
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
