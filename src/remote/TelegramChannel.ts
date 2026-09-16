import { z } from 'zod';
import { TelegramAlbumCoordinator, MAX_TELEGRAM_IMAGES_PER_MESSAGE } from './TelegramAlbumBuffer';
import { acknowledgeTelegramDisposition } from './TelegramAcknowledgement';
import { splitTelegramText } from './TelegramText';
import { sendTelegramVoice } from './TelegramVoice';
import { sendTelegramPhoto } from './TelegramPhoto';
import { downloadTelegramAttachment, downloadTelegramAttachmentToFile } from './TelegramDownloads';
import { pollTelegramUpdates, TELEGRAM_CURSOR_KEY } from './TelegramPolling';
export { MAX_TELEGRAM_IMAGES_PER_MESSAGE } from './TelegramAlbumBuffer';
export { splitTelegramText } from './TelegramText';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { createTelegramSelectionPages } from './TelegramSelectionPagination';
import { postTelegram, TelegramChatQueue } from './telegramSendQueue';

type Fetch = typeof fetch;
const TelegramSentMessageSchema = z.object({ message_id: z.number().int() });

/** Unanswered prompts are rare; this only bounds a pathological case. */
const PROMPT_MESSAGE_LIMIT = 256;
const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;
export const TELEGRAM_BOT_TOKEN_SECRET = 'forge.remote.telegram.botToken';

/** Native Telegram command menu. Parsing remains transport-independent. */
export const TELEGRAM_BOT_COMMANDS = [
  { command: 'chat', description: 'Switch to an existing conversation by number or name' },
  { command: 'chats', description: 'List recent conversations' },
  { command: 'clanker', description: 'Set approval-gate mode' },
  { command: 'compact', description: 'Compact the conversation' },
  { command: 'context', description: 'Context usage and tokens' },
  { command: 'drop', description: 'Drop queued prompt or all' },
  { command: 'help', description: 'Show all Forge commands' },
  {
    command: 'job',
    description: 'Act on a job by number or name: pause, resume, run, delete, chat',
  },
  { command: 'jobs', description: 'List the persistent agent jobs' },
  { command: 'lock', description: 'Lock this remote session' },
  { command: 'mirror', description: 'Echo sidebar answers here on/off' },
  { command: 'model', description: 'List models, or pin one to this chat by number or name' },
  { command: 'new', description: 'Start a new chat here' },
  { command: 'notify', description: 'Agent notifications on/off' },
  { command: 'queue', description: 'List queued prompts' },
  { command: 'ratelimit', description: 'Show/set messages allowed per minute' },
  { command: 'reload', description: 'Reload VS Code window' },
  { command: 'restart', description: 'Restart the pinned model' },
  { command: 'resume', description: 'Continue the current conversation' },
  { command: 'sleep', description: 'Suspend this machine (needs /sleep confirm)' },
  { command: 'status', description: 'Session, model, queue' },
  { command: 'steer', description: 'Run queued <n> or new text now' },
  { command: 'stop', description: 'Stop the current request' },
  { command: 'system', description: 'GPU, VRAM by process, RAM, drives' },
  { command: 'timeout', description: 'Show/set session timeout' },
  { command: 'unload', description: "Free memory: release this chat's model" },
  { command: 'unloadall', description: 'Free memory: release every model' },
  { command: 'view', description: 'Replay the last answers in this chat' },
  { command: 'voice', description: 'Spoken replies on/off' },
  { command: 'wake', description: 'Wake-on-LAN details, or arm a wake timer' },
  { command: 'workspace', description: 'List workspaces, or go to one by number' },
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
  /** Serializes every chat-addressed call so sends cannot overtake each other. */
  private readonly sendQueue = new TelegramChatQueue();
  private readonly albumCoordinator: TelegramAlbumCoordinator;

  constructor(private readonly options: TelegramChannelOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.albumCoordinator = new TelegramAlbumCoordinator({
      handle: async (event) => {
        if (!this.handler) return { kind: 'retry', reason: 'remote event handler is unavailable' };
        try {
          return await this.handler(event);
        } catch (err) {
          return { kind: 'retry', reason: err instanceof Error ? err.message : String(err) };
        }
      },
      acknowledge: (event, disposition, signal) =>
        this.acknowledgeDisposition(event, disposition, signal),
      commitCursor: (nextOffset) => this.options.setCursor(TELEGRAM_CURSOR_KEY, String(nextOffset)),
      onError: this.options.onError,
      onOverflow: async (event, signal) => {
        // Private-chat only, matching acknowledgeDisposition: remote
        // notifications are a private-chat convention, so a group/channel album
        // that overflows the 3-image cap is delivered without the notice.
        if (event.chatType !== 'private') return;
        await this.send(
          event.chatId,
          `Forge: albums are limited to ${MAX_TELEGRAM_IMAGES_PER_MESSAGE} images per message — I kept the first ${MAX_TELEGRAM_IMAGES_PER_MESSAGE}. Each image is capped at 10 MiB, 25 MiB total.`,
          { signal },
        ).catch((err) => {
          if (!signal.aborted) {
            this.options.onError?.(
              `Forge Telegram album notice failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      },
    });
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
  ): Promise<string[]> {
    return this.sendText(chatId, text, options);
  }

  /** Rich text is deliberately opt-in; normal agent replies stay literal. */
  async sendHtml(
    chatId: string,
    html: string,
    options?: { signal?: AbortSignal },
  ): Promise<string[]> {
    return this.sendText(chatId, html, options, 'HTML');
  }

  private async sendText(
    chatId: string,
    text: string,
    options?: { correlationId?: string; signal?: AbortSignal },
    parseMode?: 'HTML',
  ): Promise<string[]> {
    const messageIds: string[] = [];
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
          ...(parseMode ? { parse_mode: parseMode } : {}),
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
      const parsed = TelegramSentMessageSchema.safeParse(sent);
      if (parsed.success) messageIds.push(String(parsed.data.message_id));
    }
    return messageIds;
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
   * Deletes a previously sent message. The command auto-cleanup path uses this
   * to remove the owner's original /command after the configured delay. It
   * runs through `call`, so it shares the chat's send lane with the command's
   * own reply and aborts with the controller signal.
   */
  async deleteMessage(
    chatId: string,
    messageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.call(
      'deleteMessage',
      { chat_id: chatId, message_id: Number(messageId) },
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

  /**
   * Bounds how often one update may be redelivered before it is given up on.
   *
   * A `retry` disposition breaks the batch WITHOUT advancing the offset, so
   * Telegram hands back the same update immediately. That is the right answer
   * for a transient host error, and a trap for a permanent one: `/select <n>`
   * on an unrestorable conversation threw on every attempt, and the resulting
   * hot loop produced ~30 inbound events in four seconds until the rate limiter
   * turned them into rejections. The sender saw "rate limit exceeded" and never
   * saw the real cause. Three attempts, then reject with the last error and move
   * on — a poisoned update must never be able to spin.
   */
  private async poll(signal: AbortSignal): Promise<void> {
    return pollTelegramUpdates(signal, {
      call: (method, body, callSignal) => this.call(method, body, callSignal),
      getCursor: this.options.getCursor,
      setCursor: this.options.setCursor,
      getHandler: () => this.handler,
      acknowledge: (event, disposition, eventSignal) =>
        this.acknowledgeDisposition(event, disposition, eventSignal),
      albumCoordinator: this.albumCoordinator,
      onError: this.options.onError,
    });
  }

  async downloadAttachment(
    attachment: import('./types').RemoteInboundAttachment,
  ): Promise<import('./types').RemoteInboundAttachment> {
    return downloadTelegramAttachment(attachment, {
      call: (method, body, signal) => this.call(method, body, signal),
      fetchImpl: this.fetchImpl,
      token: this.options.token,
    });
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
    return downloadTelegramAttachmentToFile(providerFileId, targetPath, signal, {
      call: (method, body, callSignal) => this.call(method, body, callSignal),
      fetchImpl: this.fetchImpl,
      token: this.options.token,
    });
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
  private acknowledgeDisposition(
    event: Extract<RemoteInboundEvent, { kind: 'text' | 'voice' }>,
    disposition: RemoteInboundDisposition,
    signal: AbortSignal,
  ): Promise<void> {
    return acknowledgeTelegramDisposition(
      event,
      disposition,
      signal,
      (chatId, text, options) => this.send(chatId, text, options).then(() => undefined),
      this.options.onError,
    );
  }

  async sendPhoto(
    chatId: string,
    filePath: string,
    caption: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { fetchImpl, sendQueue } = this;
    await sendTelegramPhoto(
      fetchImpl,
      this.options.token,
      sendQueue,
      chatId,
      filePath,
      caption,
      signal,
    );
  }

  async sendVoice(chatId: string, oggPath: string, signal?: AbortSignal): Promise<void> {
    await sendTelegramVoice(
      this.fetchImpl,
      this.options.token,
      this.sendQueue,
      chatId,
      oggPath,
      signal,
    );
  }

  /**
   * Every Bot API call, in its chat's lane. Calls that name no chat -- the
   * `getUpdates` long poll, `getMe`, `setMyCommands` -- run unqueued, so
   * inbound polling is never held up behind an outbound send.
   */
  private call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const chatId = body.chat_id === undefined ? undefined : String(body.chat_id);
    return this.sendQueue.run(chatId, () =>
      postTelegram(this.fetchImpl, this.options.token, method, body, signal),
    );
  }
}
